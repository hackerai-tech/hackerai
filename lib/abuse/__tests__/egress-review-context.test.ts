/** @jest-environment node */
jest.mock("@/lib/rate-limit/redis", () => ({ createRedisClient: jest.fn() }));

import { createHash } from "node:crypto";
import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  egressAbuseReviewGate,
  MAX_ACQUISITION_LINKS,
  readAcquisitionLinks,
  recordEgressReviewAcquisition,
} from "../egress-review-context";

/**
 * Stores what the module writes and reads it back. The write script's
 * coalescing runs against real Redis in
 * scripts/tests/egress-review-acquisition.integration.ts; here a write is a
 * plain add of the acquisition member.
 */
function sortedSetRedis() {
  const sets = new Map<string, Map<string, number>>();
  const set = (key: string) => {
    if (!sets.has(key)) sets.set(key, new Map());
    return sets.get(key)!;
  };
  const redis = {
    eval: jest.fn(
      async (_script: string, [key]: string[], [prefix, time]: string[]) => {
        set(key).set(`${prefix}${time}`, Number(time));
        return 1;
      },
    ),
    zadd: (key: string, score: number, member: string) =>
      set(key).set(member, score),
    zrange: jest.fn(async (key: string) =>
      [...set(key).entries()]
        .sort((a, b) => a[1] - b[1])
        .flatMap(([member, score]) => [member, score]),
    ),
  };
  return redis;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const originalEnv = process.env;
let redis: ReturnType<typeof sortedSetRedis>;
const base = { region: "us" as const, userId: "user_1", sandboxId: "sbx_1" };

beforeEach(() => {
  process.env = { ...originalEnv, E2B_EGRESS_ABUSE_REVIEW_ENABLED: "true" };
  redis = sortedSetRedis();
  jest.mocked(createRedisClient).mockReturnValue(redis as never);
});
afterAll(() => {
  process.env = originalEnv;
});

it.each([
  [undefined, "off"],
  ["", "off"],
  ["false", "off"],
  ["true", "on"],
  ["TRUE", "invalid"],
  ["1", "invalid"],
])("parses the review gate %p as %s", (value, expected) => {
  expect(
    egressAbuseReviewGate({ E2B_EGRESS_ABUSE_REVIEW_ENABLED: value } as never),
  ).toBe(expected);
});

it("is off by default and does not touch the store", async () => {
  delete process.env.E2B_EGRESS_ABUSE_REVIEW_ENABLED;
  recordEgressReviewAcquisition({ ...base, chatId: "c", runId: "run_a" });
  await flush();
  expect(createRedisClient).not.toHaveBeenCalled();
});

it("does not record acquisitions without a server chat and run", async () => {
  recordEgressReviewAcquisition({ ...base, chatId: "chat_a" });
  recordEgressReviewAcquisition({ ...base, runId: "run_a" });
  recordEgressReviewAcquisition({ ...base, chatId: "a|b", runId: "run_a" });
  await flush();
  expect(redis.eval).not.toHaveBeenCalled();
});

it("keys records by account and workspace", async () => {
  recordEgressReviewAcquisition({
    ...base,
    chatId: "chat_a",
    runId: "run_a",
    now: 1_000,
  });
  await flush();
  await expect(
    readAcquisitionLinks(redis as never, "us", "user_1", "sbx_1", 0),
  ).resolves.toEqual({
    links: [
      { kind: "parent", chatId: "chat_a", runId: "run_a", acquiredAt: 1_000 },
    ],
    complete: true,
    stored: 1,
  });
  // Another account's workspace with the same sandbox ID is a different key.
  expect(
    (await readAcquisitionLinks(redis as never, "us", "user_2", "sbx_1", 0))
      .links,
  ).toEqual([]);
});

it("tells trimmed history from an unreadable record", async () => {
  recordEgressReviewAcquisition({
    ...base,
    chatId: "c",
    runId: "run_0",
    now: 1,
  });
  await flush();
  const [[, [key]]] = redis.eval.mock.calls;
  for (let index = 1; index <= MAX_ACQUISITION_LINKS; index++)
    redis.zadd(key, 1 + index, `p|c|run_${index}|${1 + index}`);
  await expect(
    readAcquisitionLinks(redis as never, "us", "user_1", "sbx_1", 0),
  ).resolves.toMatchObject({
    complete: false,
    incomplete: "trimmed",
    stored: MAX_ACQUISITION_LINKS + 1,
  });
  // A member whose time does not match its score is unreadable, whatever the count.
  redis.zadd(key, 99, "p|c|run_x|98");
  await expect(
    readAcquisitionLinks(redis as never, "us", "user_1", "sbx_1", 0),
  ).resolves.toMatchObject({ complete: false, incomplete: "invalid" });
});

it("never reads links stored in the v1 per-run format", async () => {
  // v1 kept one member per run at its latest time, which may have replaced
  // the acquisition that placed the run before a burst.
  const v1Key = `egress-review:v1:us:acquisition:${createHash("sha256")
    .update("user_1\nsbx_1")
    .digest("hex")
    .slice(0, 32)}`;
  redis.zadd(v1Key, 5_000, "p|chat_old|run_old");
  await expect(
    readAcquisitionLinks(redis as never, "us", "user_1", "sbx_1", 0),
  ).resolves.toEqual({ links: [], complete: true, stored: 0 });
});

it("never delays, throws from, or fails an acquisition when the store is down", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  redis.eval.mockImplementationOnce(() => {
    throw new Error("store down");
  });
  expect(() =>
    recordEgressReviewAcquisition({ ...base, chatId: "c", runId: "run_a" }),
  ).not.toThrow();
  // A hung write returns immediately and is abandoned after its budget.
  jest.useFakeTimers();
  try {
    redis.eval.mockReturnValueOnce(new Promise(() => {}));
    expect(
      recordEgressReviewAcquisition({ ...base, chatId: "c", runId: "run_b" }),
    ).toBeUndefined();
    await jest.advanceTimersByTimeAsync(2_000);
  } finally {
    jest.useRealTimers();
  }
  expect(warn).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/user_1|sbx_1|run_/);
  warn.mockRestore();
});
