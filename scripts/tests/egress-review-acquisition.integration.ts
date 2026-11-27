/** @jest-environment node */
// Explicit Redis integration suite, run by CI after redis-server installation.
// The acquisition-link Lua script executes unchanged in an isolated Redis; the
// recorder and reader are the application code.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";

let mockSocket: string;
const mockCommand = (...args: Array<string | number>) =>
  JSON.parse(
    execFileSync(
      "redis-cli",
      ["-s", mockSocket, "--json", ...args.map(String)],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
jest.mock("../../lib/rate-limit/redis", () => ({
  createRedisClient: () => ({
    eval: async (lua: string, keys: string[], args: string[]) =>
      mockCommand("EVAL", lua, keys.length, ...keys, ...args),
    // redis-cli prints RESP3 pairs; Upstash returns a flat list.
    zrange: async (key: string, start: number, stop: number) =>
      mockCommand("ZRANGE", key, start, stop, "WITHSCORES").flat(),
  }),
}));

import { createRedisClient } from "../../lib/rate-limit/redis";
import {
  ACQUISITION_LINK_RETENTION_S,
  ACQUISITION_LINK_TTL_S,
  MAX_ACQUISITION_RECORDS,
  readAcquisitionLinks,
  recordEgressReviewAcquisition,
} from "../../lib/abuse/egress-review-context";

const MINUTE = 60_000;
const LOOK_BACK = ACQUISITION_LINK_TTL_S * 1_000;
const RETENTION = ACQUISITION_LINK_RETENTION_S * 1_000;
const T0 = 1_700_000_000_000;
const workspace = {
  region: "us" as const,
  userId: "user_1",
  sandboxId: "sbx_1",
};
let server: ChildProcess;
let directory: string;
const env = process.env;

const acquire = (runId: string, now: number, chatId = `chat_${runId}`) =>
  recordEgressReviewAcquisition({ ...workspace, chatId, runId, now });
const read = (since = 0) =>
  readAcquisitionLinks(
    createRedisClient() as never,
    "us",
    workspace.userId,
    workspace.sandboxId,
    since,
  );
/** The links a review of the burst minute starting at `burst` would use. */
const reviewLinks = async (burst: number) => {
  const result = await read(burst - LOOK_BACK);
  return {
    ...result,
    runs: [
      ...new Set(
        result.links
          .filter((link) => link.acquiredAt < burst + MINUTE)
          .map((link) => link.runId),
      ),
    ].sort(),
  };
};
/**
 * The writer deployed before history was expanded, verbatim, so mixed
 * deployments run against the stored data it actually leaves: 16 records plus
 * one trim sentinel and no metadata.
 */
const PREVIOUS_WRITER = `
local key, prefix, now = KEYS[1], ARGV[1], tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', key, '-inf', ARGV[3])
local member = prefix .. ARGV[2]
if not redis.call('ZSCORE', key, member) then
  local entries = redis.call('ZRANGE', key, 0, -1, 'WITHSCORES')
  local latest, latestAt, previousAt
  for i = 1, #entries, 2 do
    local scoreText = entries[i + 1]
    local score = tonumber(scoreText)
    if score and scoreText:match('^-?%d+$') and math.abs(score) <= 9007199254740991
      and entries[i] == prefix .. scoreText then
      previousAt, latest, latestAt = latestAt, entries[i], score
    end
  end
  if previousAt and latestAt < now and now - previousAt <= tonumber(ARGV[4]) then
    redis.call('ZREM', key, latest)
  end
  redis.call('ZADD', key, now, member)
end
redis.call('ZREMRANGEBYRANK', key, 0, -tonumber(ARGV[5]))
redis.call('EXPIRE', key, ARGV[6])
return 1`;
const previousAcquire = (runId: string, now: number) =>
  mockCommand(
    "EVAL",
    PREVIOUS_WRITER,
    1,
    linkKey(),
    `p|chat_${runId}|${runId}|`,
    now,
    now - RETENTION,
    LOOK_BACK,
    18,
    ACQUISITION_LINK_RETENTION_S,
  );
/**
 * The reader deployed before history was expanded: complete only when every
 * member is a record whose time matches its score and at most 16 are stored.
 */
const previousReaderComplete = () => {
  const members: Array<[string, number]> = mockCommand(
    "ZRANGE",
    linkKey(),
    0,
    -1,
    "WITHSCORES",
  );
  return (
    members.length <= 16 &&
    members.every(
      ([member, score]) =>
        /^[ps]\|[A-Za-z0-9_.:-]+\|[A-Za-z0-9_.:-]+\|-?\d+$/.test(member) &&
        member.endsWith(`|${score}`),
    )
  );
};
/** Distinct runs, one acquisition a minute from `start`. */
const acquireRuns = (count: number, start = T0, name = "run") => {
  for (let index = 0; index < count; index++)
    acquire(`${name}_${index}`, start + index * MINUTE);
};

/**
 * The key the module writes. Tests that add members directly would otherwise
 * write elsewhere, and fail, if this drifted from the module's key.
 */
const linkKey = () =>
  `egress-review:v2:us:acquisition:${createHash("sha256")
    .update(`${workspace.userId}\n${workspace.sandboxId}`)
    .digest("hex")
    .slice(0, 32)}`;

beforeAll(async () => {
  directory = mkdtempSync("/tmp/hai-egress-links-");
  mockSocket = join(directory, "redis.sock");
  server = spawn(
    "redis-server",
    [
      "--port",
      "0",
      "--unixsocket",
      mockSocket,
      "--save",
      "",
      "--appendonly",
      "no",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.stdout!.on("data", (data) => {
      if (String(data).toLowerCase().includes("ready to accept connections"))
        resolve();
    });
    server.once("exit", (code) =>
      reject(new Error(`Redis exited before readiness (${code})`)),
    );
  });
});
afterAll(async () => {
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  await exited;
  rmSync(directory, { recursive: true, force: true });
  process.env = env;
});
beforeEach(() => {
  mockCommand("FLUSHDB");
  process.env = { ...env, E2B_EGRESS_ABUSE_REVIEW_ENABLED: "true" };
});

it("keeps distinct runs visible while one run reconnects many times", async () => {
  // The bug: each reconnect added a record, so a busy run filled the bounded
  // set and every review of this workspace abstained as incomplete.
  acquire("run_busy", T0);
  acquire("run_other", T0 + MINUTE);
  for (let index = 1; index <= 200; index++)
    acquire("run_busy", T0 + index * 30_000);
  acquire("run_late", T0 + 101 * MINUTE);

  const review = await reviewLinks(T0 + 102 * MINUTE);
  expect(review.complete).toBe(true);
  expect(review.runs).toEqual(["run_busy", "run_late", "run_other"]);
  expect(review.stored).toBeLessThanOrEqual(6);
});

it("keeps the record that places a run before a burst after it reconnects", async () => {
  const burst = T0 + 30 * MINUTE;
  acquire("run_a", T0);
  for (let index = 1; index <= 100; index++)
    acquire("run_a", burst + index * MINUTE);
  expect((await reviewLinks(burst)).runs).toEqual(["run_a"]);
});

it("keeps a witness for every review window a run acquired in", async () => {
  // Deterministic pseudo-random reconnects, including gaps longer than the
  // look-back, checked against every burst minute a review could still verify.
  let seed = 7;
  const random = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
  const actual: number[] = [];
  let now = T0;
  for (let index = 0; index < 120; index++) {
    now +=
      Math.floor((random() < 0.1 ? LOOK_BACK * 1.5 : 20 * MINUTE) * random()) +
      1;
    acquire("run_a", now);
    actual.push(now);
    if (index % 10 !== 9) continue;
    const { links, complete } = await read();
    expect(complete).toBe(true);
    // Every burst whose telemetry a review can still read.
    for (let burst = now - 2 * 60 * MINUTE; burst <= now; burst += 7 * MINUTE) {
      const inWindow = (time: number) =>
        time >= burst - LOOK_BACK && time < burst + MINUTE;
      expect(links.some((link) => inWindow(link.acquiredAt))).toBe(
        actual.some(inWindow),
      );
    }
  }
});

it("does not let a later write trim a record its pending review still needs", async () => {
  acquire("run_old", T0);
  // A burst just inside the look-back of that acquisition, reviewed after
  // another run reconnected; the review can start up to two hours later.
  const burst = T0 + LOOK_BACK - MINUTE;
  acquire("run_new", burst + 90 * MINUTE);
  expect((await reviewLinks(burst)).runs).toEqual(["run_old"]);
});

it("is idempotent for a retried write of the same acquisition", async () => {
  acquire("run_a", T0);
  acquire("run_a", T0 + MINUTE);
  acquire("run_a", T0 + MINUTE);
  expect((await read()).links.map((link) => link.acquiredAt)).toEqual([
    T0,
    T0 + MINUTE,
  ]);
});

it("keeps more than 16 records of coalesced runs complete", async () => {
  // Production histories held 17 records of runs that each kept a first and a
  // latest acquisition, which the previous bound reported as trimmed.
  for (let index = 0; index < 9; index++) {
    acquire(`run_${index}`, T0 + index * MINUTE);
    acquire(`run_${index}`, T0 + (60 + index) * MINUTE);
  }
  const review = await reviewLinks(T0 + 90 * MINUTE);
  expect(review).toMatchObject({ complete: true, stored: 18 });
  expect(review.runs).toHaveLength(9);
});

it("reports truncation only for windows reaching the newest eviction", async () => {
  acquireRuns(MAX_ACQUISITION_RECORDS + 2);
  // run_0 and run_1 were evicted; run_1's time bounds what is missing.
  const bound = T0 + MINUTE;
  await expect(read(bound)).resolves.toMatchObject({
    complete: false,
    incomplete: "trimmed",
    stored: MAX_ACQUISITION_RECORDS,
  });
  const after = await read(bound + 1);
  expect(after.complete).toBe(true);
  expect(after.links[0]).toMatchObject({ runId: "run_2" });

  // A run reconnecting in the full set evicts once, then is coalesced.
  for (let index = 1; index <= 20; index++)
    acquire("run_49", T0 + (49 + index) * MINUTE);
  await expect(read(T0 + 2 * MINUTE)).resolves.toMatchObject({
    incomplete: "trimmed",
  });
  const coalesced = await read(T0 + 2 * MINUTE + 1);
  expect(coalesced).toMatchObject({ complete: true });
  expect(coalesced.links[0]).toMatchObject({ runId: "run_3" });
});

it("bounds an eviction that tied with a surviving record", async () => {
  // Ties rank by member, so run_a is evicted while run_b at the same time stays.
  acquire("run_a", T0);
  acquire("run_b", T0);
  acquireRuns(MAX_ACQUISITION_RECORDS - 1, T0 + MINUTE);
  const tied = await read(T0);
  expect(tied).toMatchObject({ complete: false, incomplete: "trimmed" });
  expect(tied.links[0]).toMatchObject({ runId: "run_b" });
  await expect(read(T0 + 1)).resolves.toMatchObject({ complete: true });
});

it("bounds an out-of-order acquisition evicted on arrival", async () => {
  acquireRuns(MAX_ACQUISITION_RECORDS, T0 + MINUTE);
  acquire("run_late", T0);
  await expect(read(T0)).resolves.toMatchObject({ incomplete: "trimmed" });
  await expect(read(T0 + 1)).resolves.toMatchObject({
    complete: true,
    stored: MAX_ACQUISITION_RECORDS,
  });
});

it("clears an aged-out bound and bounds a later expansion again", async () => {
  acquireRuns(MAX_ACQUISITION_RECORDS + 1);
  const later = T0 + RETENTION + MAX_ACQUISITION_RECORDS * MINUTE;
  acquire("run_next", later);
  // Retention removed every earlier record, so nothing missing is in range.
  await expect(read(later - LOOK_BACK)).resolves.toMatchObject({
    complete: true,
    stored: 1,
  });
  expect(previousReaderComplete()).toBe(true);

  acquireRuns(MAX_ACQUISITION_RECORDS, later + MINUTE, "again");
  await expect(read(later)).resolves.toMatchObject({ incomplete: "trimmed" });
  await expect(read(later + 1)).resolves.toMatchObject({ complete: true });
});

describe("mixed writer and reader deployments", () => {
  it("never reads expanded history as complete in the previous reader", async () => {
    acquireRuns(16);
    expect(previousReaderComplete()).toBe(true);
    acquire("run_16", T0 + 16 * MINUTE);
    expect(previousReaderComplete()).toBe(false);
    await expect(read(1)).resolves.toMatchObject({ complete: true });
  });

  it("re-establishes a bound after the previous writer trims expanded history", async () => {
    acquireRuns(30);
    // It removes the metadata in its time prune, then keeps 17 records.
    previousAcquire("run_old", T0 + 30 * MINUTE);
    await expect(read(T0 + 60 * MINUTE)).resolves.toMatchObject({
      incomplete: "trimmed",
      stored: 17,
    });
    // Its oldest survivor, run_14, bounds what it evicted.
    acquire("run_new", T0 + 31 * MINUTE);
    const oldest = T0 + 14 * MINUTE;
    await expect(read(oldest)).resolves.toMatchObject({
      incomplete: "trimmed",
    });
    await expect(read(oldest + 1)).resolves.toMatchObject({
      complete: true,
      stored: 18,
    });
  });

  it("bounds a previous trim by the oldest record before an out-of-order write", async () => {
    for (let index = 0; index <= 20; index++)
      previousAcquire(`run_${index}`, T0 + (10 + index) * MINUTE);
    // A late acquisition ranks below the oldest record the previous writer kept.
    acquire("run_late", T0);
    const oldest = T0 + 14 * MINUTE;
    await expect(read(T0 + MINUTE)).resolves.toMatchObject({
      incomplete: "trimmed",
    });
    await expect(read(oldest)).resolves.toMatchObject({
      incomplete: "trimmed",
    });
    await expect(read(oldest + 1)).resolves.toMatchObject({ complete: true });
  });
});

it.each([
  [
    "duplicate",
    [
      ["m|0", 0],
      ["m|1", 0],
    ],
  ],
  ["malformed", [["m|-1", 0]]],
  ["misplaced", [["m|0", T0 + 10 * MINUTE]]],
] as Array<[string, Array<[string, number]>]>)(
  "never derives completeness from %s metadata",
  async (_name, marks) => {
    acquireRuns(20);
    for (const [member, score] of marks)
      mockCommand("ZADD", linkKey(), score, member);
    await expect(read(T0 + 30 * MINUTE)).resolves.toMatchObject({
      incomplete: "invalid",
    });
    // The next write cannot tell what was lost before it, so nothing up to
    // the newest time present or the write itself is complete.
    const now = T0 + 25 * MINUTE;
    acquire("run_next", now);
    await expect(read(now)).resolves.toMatchObject({ incomplete: "trimmed" });
    await expect(read(now + 1)).resolves.toMatchObject({ complete: true });
  },
);

it("bounds an unreadable record once it is evicted", async () => {
  mockCommand("ZADD", linkKey(), T0, "p|chat_x|run_x|corrupt");
  acquireRuns(MAX_ACQUISITION_RECORDS, T0 + MINUTE);
  await expect(read(T0)).resolves.toMatchObject({ incomplete: "trimmed" });
  await expect(read(T0 + 1)).resolves.toMatchObject({ complete: true });
});

it("never turns previously trimmed history into a complete set", async () => {
  // History from the previous writer, which kept one record per acquisition:
  // already past the bound because one run reconnected repeatedly.
  acquire("run_a", T0);
  for (let index = 1; index <= 16; index++) {
    const time = T0 + index * MINUTE;
    mockCommand("ZADD", linkKey(), time, `p|chat_run_a|run_a|${time}`);
  }
  expect((await read()).complete).toBe(false);

  for (let index = 1; index <= 20; index++)
    acquire("run_a", T0 + (16 + index) * MINUTE);
  acquire("run_b", T0 + 60 * MINUTE);
  expect((await read()).complete).toBe(false);
});

it("leaves an unreadable member of the same run in place", async () => {
  acquire("run_a", T0);
  mockCommand("ZADD", linkKey(), T0 + 1, "p|chat_run_a|run_a|corrupt");
  acquire("run_a", T0 + MINUTE);
  acquire("run_a", T0 + 2 * MINUTE);
  expect(await read()).toMatchObject({
    complete: false,
    incomplete: "invalid",
  });
});

it("does not coalesce an unreadable fractional time with a matching score", async () => {
  acquire("run_a", T0);
  const fractionalTime = T0 + 0.5;
  const member = `p|chat_run_a|run_a|${fractionalTime}`;
  mockCommand("ZADD", linkKey(), fractionalTime, member);
  acquire("run_a", T0 + MINUTE);
  expect(await read()).toMatchObject({
    complete: false,
    incomplete: "invalid",
  });
  expect(mockCommand("ZSCORE", linkKey(), member)).toBe(fractionalTime);
});
