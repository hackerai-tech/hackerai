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

/** Sorted-set semantics of the Upstash calls the module uses. */
function sortedSetRedis() {
  const sets = new Map<string, Map<string, number>>();
  const set = (key: string) => {
    if (!sets.has(key)) sets.set(key, new Map());
    return sets.get(key)!;
  };
  const ordered = (key: string) =>
    [...set(key).entries()].sort((a, b) => a[1] - b[1]);
  const redis = {
    pipeline: jest.fn(() => {
      const ops: Array<() => void> = [];
      const chain = {
        zadd(
          key: string,
          { score, member }: { score: number; member: string },
        ) {
          ops.push(() => set(key).set(member, score));
          return chain;
        },
        zremrangebyscore(key: string, min: number, max: number) {
          ops.push(() => {
            for (const [member, score] of set(key))
              if (score >= min && score <= max) set(key).delete(member);
          });
          return chain;
        },
        zremrangebyrank(key: string, start: number, stop: number) {
          ops.push(() => {
            const entries = ordered(key);
            const end = stop < 0 ? entries.length + stop : stop;
            // Redis treats a resolved stop before start as an empty range.
            if (end < start) return;
            entries
              .slice(start, end + 1)
              .forEach(([member]) => set(key).delete(member));
          });
          return chain;
        },
        expire() {
          return chain;
        },
        exec: jest.fn(async () => ops.forEach((op) => op())),
      };
      return chain;
    }),
    zrange: jest.fn(async (key: string) =>
      ordered(key).flatMap(([member, score]) => [member, score]),
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

it("keeps every acquisition, so a later one cannot replace an earlier one", async () => {
  recordEgressReviewAcquisition({
    ...base,
    chatId: "chat_a",
    runId: "run_a",
    now: 1_000,
  });
  recordEgressReviewAcquisition({
    ...base,
    chatId: "chat_b",
    runId: "run_b",
    runKind: "subagent",
    now: 2_000,
  });
  // The same run acquires again later, and one write is retried.
  for (let attempt = 0; attempt < 2; attempt++)
    recordEgressReviewAcquisition({
      ...base,
      chatId: "chat_a",
      runId: "run_a",
      now: 3_000,
    });
  await flush();
  const read = await readAcquisitionLinks(
    redis as never,
    "us",
    "user_1",
    "sbx_1",
    0,
  );
  expect(read).toEqual({
    complete: true,
    links: [
      { kind: "parent", chatId: "chat_a", runId: "run_a", acquiredAt: 1_000 },
      { kind: "subagent", chatId: "chat_b", runId: "run_b", acquiredAt: 2_000 },
      { kind: "parent", chatId: "chat_a", runId: "run_a", acquiredAt: 3_000 },
    ],
  });
  // Another account's workspace with the same sandbox ID is a different key.
  expect(
    (await readAcquisitionLinks(redis as never, "us", "user_2", "sbx_1", 0))
      .links,
  ).toEqual([]);
});

it("does not record acquisitions without a server chat and run", async () => {
  recordEgressReviewAcquisition({ ...base, chatId: "chat_a" });
  recordEgressReviewAcquisition({ ...base, runId: "run_a" });
  recordEgressReviewAcquisition({ ...base, chatId: "a|b", runId: "run_a" });
  await flush();
  expect(redis.pipeline).not.toHaveBeenCalled();
});

it("reports a trimmed link set as incomplete", async () => {
  for (let index = 0; index <= MAX_ACQUISITION_LINKS + 3; index++)
    recordEgressReviewAcquisition({
      ...base,
      chatId: "chat",
      runId: `run_${index}`,
      now: 1_000 + index,
    });
  await flush();
  const read = await readAcquisitionLinks(
    redis as never,
    "us",
    "user_1",
    "sbx_1",
    0,
  );
  // One more than the bound is kept so the reader can see the trim.
  expect(read.links).toHaveLength(MAX_ACQUISITION_LINKS + 1);
  expect(read.complete).toBe(false);
});

it("reports repeated acquisitions by one run beyond the bound as incomplete", async () => {
  for (let index = 0; index <= MAX_ACQUISITION_LINKS; index++)
    recordEgressReviewAcquisition({
      ...base,
      chatId: "chat",
      runId: "run_a",
      now: 1_000 + index,
    });
  await flush();
  const read = await readAcquisitionLinks(
    redis as never,
    "us",
    "user_1",
    "sbx_1",
    0,
  );
  expect(read.complete).toBe(false);
});

it("never reads links stored in the v1 per-run format", async () => {
  // v1 kept one member per run at its latest time, which may have replaced
  // the acquisition that placed the run before a burst.
  const v1Key = `egress-review:v1:us:acquisition:${createHash("sha256")
    .update("user_1\nsbx_1")
    .digest("hex")
    .slice(0, 32)}`;
  redis
    .pipeline()
    .zadd(v1Key, { score: 5_000, member: "p|chat_old|run_old" })
    .exec();
  await flush();
  await expect(
    readAcquisitionLinks(redis as never, "us", "user_1", "sbx_1", 0),
  ).resolves.toEqual({ links: [], complete: true });
});

it("never delays, throws from, or fails an acquisition when the store is down", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  redis.pipeline.mockImplementationOnce(() => {
    throw new Error("store down");
  });
  expect(() =>
    recordEgressReviewAcquisition({ ...base, chatId: "c", runId: "run_a" }),
  ).not.toThrow();
  // A hung write returns immediately and is abandoned after its budget.
  jest.useFakeTimers();
  try {
    const chain = sortedSetRedis().pipeline();
    chain.exec.mockReturnValue(new Promise(() => {}));
    redis.pipeline.mockReturnValueOnce(chain);
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
