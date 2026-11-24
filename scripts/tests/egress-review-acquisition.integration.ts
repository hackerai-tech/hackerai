/** @jest-environment node */
// Explicit Redis integration suite, run by CI after redis-server installation.
// The acquisition-link Lua script executes unchanged in an isolated Redis; the
// recorder and reader are the application code.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
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
    zrange: async (key: string) =>
      mockCommand("ZRANGE", key, 0, -1, "WITHSCORES").flat(),
  }),
}));

import { createRedisClient } from "../../lib/rate-limit/redis";
import {
  ACQUISITION_LINK_TTL_S,
  MAX_ACQUISITION_LINKS,
  readAcquisitionLinks,
  recordEgressReviewAcquisition,
} from "../../lib/abuse/egress-review-context";

const MINUTE = 60_000;
const LOOK_BACK = ACQUISITION_LINK_TTL_S * 1_000;
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
/** The key the module writes, found without restating its hash. */
const linkKey = () => {
  const [key] = mockCommand("KEYS", "egress-review:v2:*");
  return key as string;
};

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

it("still reports too many distinct runs as incomplete", async () => {
  for (let index = 0; index <= MAX_ACQUISITION_LINKS + 2; index++)
    acquire(`run_${index}`, T0 + index * MINUTE);
  const result = await read();
  expect(result).toMatchObject({ complete: false, incomplete: "trimmed" });
  expect(result.stored).toBe(MAX_ACQUISITION_LINKS + 1);
});

it("never turns previously trimmed history into a complete set", async () => {
  // History from the previous writer, which kept one record per acquisition:
  // already past the bound because one run reconnected repeatedly.
  acquire("run_a", T0);
  for (let index = 1; index <= MAX_ACQUISITION_LINKS; index++) {
    const time = T0 + index * MINUTE;
    mockCommand("ZADD", linkKey(), time, `p|chat_run_a|run_a|${time}`);
  }
  expect((await read()).complete).toBe(false);

  for (let index = 1; index <= 20; index++)
    acquire("run_a", T0 + (MAX_ACQUISITION_LINKS + index) * MINUTE);
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
