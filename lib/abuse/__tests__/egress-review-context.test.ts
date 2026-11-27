/** @jest-environment node */
jest.mock("@/lib/rate-limit/redis", () => ({ createRedisClient: jest.fn() }));

import { createHash } from "node:crypto";
import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  egressAbuseReviewGate,
  MAX_ACQUISITION_RECORDS,
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
    zrem: (key: string, member: string) => set(key).delete(member),
    zrange: jest.fn(async (key: string, start: number, stop: number) =>
      [...set(key).entries()]
        .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
        .slice(start, stop < 0 ? undefined : stop + 1)
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

describe("history completeness", () => {
  let key: string;
  const read = (since = 0) =>
    readAcquisitionLinks(redis as never, "us", "user_1", "sbx_1", since);
  /** Records at 1..count, the way the writer leaves them. */
  const records = async (count: number) => {
    recordEgressReviewAcquisition({
      ...base,
      chatId: "c",
      runId: "run_1",
      now: 1,
    });
    await flush();
    [[, [key]]] = redis.eval.mock.calls;
    for (let index = 2; index <= count; index++)
      redis.zadd(key, index, `p|c|run_${index}|${index}`);
  };

  it("never reads 17 unmarked records from the previous writer as complete", async () => {
    // That writer kept 16 records and one sentinel and wrote no metadata.
    await records(17);
    await expect(read()).resolves.toMatchObject({
      complete: false,
      incomplete: "trimmed",
      stored: 17,
    });
  });

  it("reads expanded history as complete only after the trim bound", async () => {
    await records(MAX_ACQUISITION_RECORDS);
    redis.zadd(key, 0, "m|0");
    await expect(read(1)).resolves.toMatchObject({
      complete: true,
      stored: MAX_ACQUISITION_RECORDS,
    });
    redis.zrem(key, "m|0");
    redis.zadd(key, 0, "m|5");
    // A record at the bound may have been evicted, so the bound is excluded.
    await expect(read(5)).resolves.toMatchObject({ incomplete: "trimmed" });
    const after = await read(6);
    expect(after.complete).toBe(true);
    expect(after.links[0]?.acquiredAt).toBe(6);
  });

  it.each([
    ["a duplicate", ["m|0", 0], ["m|1", 0]],
    ["a non-zero score", ["m|0", 3]],
    ["a non-canonical bound", ["m|01", 0]],
    ["a non-numeric bound", ["m|x", 0]],
    ["an unsafe bound", ["m|9007199254740993", 0]],
  ] as Array<[string, ...Array<[string, number]>]>)(
    "treats %s metadata member as unreadable",
    async (_name, ...marks) => {
      await records(17);
      for (const [member, score] of marks) redis.zadd(key, score, member);
      await expect(read(100)).resolves.toMatchObject({
        complete: false,
        incomplete: "invalid",
      });
    },
  );

  it("treats a record whose time does not match its score as unreadable", async () => {
    await records(3);
    redis.zadd(key, 0, "m|0");
    redis.zadd(key, 99, "p|c|run_x|98");
    await expect(read(1)).resolves.toMatchObject({
      complete: false,
      incomplete: "invalid",
    });
  });

  it("treats more members than a writer leaves as unreadable", async () => {
    await records(MAX_ACQUISITION_RECORDS + 1);
    redis.zadd(key, 0, "m|0");
    await expect(read(1)).resolves.toMatchObject({ incomplete: "invalid" });
  });
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
