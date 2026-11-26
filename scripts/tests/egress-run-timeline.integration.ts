/** @jest-environment node */
// Explicit Redis integration suite, run by CI after redis-server installation.
// The run timeline's Lua scripts execute unchanged in an isolated Redis; the
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
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
jest.mock("../../lib/rate-limit/redis", () => ({
  createRedisClient: () => ({
    eval: async (lua: string, keys: string[], args: string[]) =>
      mockCommand("EVAL", lua, keys.length, ...keys, ...args),
  }),
}));

import {
  ACQUISITION_LINK_RETENTION_S,
  ACQUISITION_LINK_TTL_S,
} from "../../lib/abuse/egress-review-context";
import {
  MAX_TIMELINE_RUNS,
  readRunTimeline,
  recordRunTimelineAcquisition,
} from "../../lib/abuse/egress-run-timeline";

const MINUTE = 60_000;
const LOOK_BACK = ACQUISITION_LINK_TTL_S * 1_000;
const RETENTION = ACQUISITION_LINK_RETENTION_S * 1_000;
const T0 = 1_700_000_000_000;
const workspace = { region: "us" as const, userId: "user_1" };
let server: ChildProcess;
let directory: string;
const env = process.env;

const acquire = (
  runId: string,
  now: number,
  options: { kind?: "parent" | "subagent"; sandboxId?: string } = {},
) =>
  recordRunTimelineAcquisition({
    ...workspace,
    sandboxId: options.sandboxId ?? "sbx_1",
    chatId: `chat_${runId}`,
    runId,
    runKind: options.kind,
    now,
  });
/** Writes are not awaited by the recorder; redis-cli is synchronous. */
const read = (burstStart: number, sandboxIds = ["sbx_1"]) =>
  readRunTimeline({
    ...workspace,
    sandboxIds,
    burstStart,
    burstEnd: burstStart + MINUTE,
  });
const summary = async (burstStart: number, sandboxIds?: string[]) =>
  (await read(burstStart, sandboxIds)).summary;
const runsKey = () =>
  mockCommand("KEYS", "egress-review:timeline:v1:*:runs")[0];

beforeAll(async () => {
  directory = mkdtempSync("/tmp/hai-egress-timeline-");
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
  process.env = {
    ...env,
    E2B_EGRESS_ABUSE_REVIEW_ENABLED: "true",
    E2B_EGRESS_RUN_TIMELINE_SHADOW_ENABLED: "true",
  };
});

it("keeps a long-running run listed after it reconnects past the burst", async () => {
  // Acquired before the burst's look-back, and again only after it: the run
  // was alive throughout, so it stays a possible run for the burst.
  const burst = T0 + LOOK_BACK + 60 * MINUTE;
  acquire("run_long", T0);
  for (let index = 1; index <= 50; index++)
    acquire("run_long", burst + index * MINUTE);
  await expect(summary(burst)).resolves.toMatchObject({
    assessment: "one_possible",
    parents: 1,
    reconnected: 1,
    acquiredAfterBurst: 1,
  });
  // One record per run, however often it reconnects.
  expect(mockCommand("ZCARD", runsKey())).toBe(1);
});

it("does not let another run's reconnect burst evict a listed run", async () => {
  const burst = T0 + 30 * MINUTE;
  acquire("run_long", T0);
  acquire("run_short", burst - 5 * MINUTE);
  for (let index = 0; index < 5 * MAX_TIMELINE_RUNS; index++)
    acquire("run_short", burst + index * 10_000);
  const result = await read(burst);
  expect(result.summary).toMatchObject({
    assessment: "several",
    parents: 2,
    limitations: [],
  });
  expect(
    result.lists({
      kind: "parent",
      chatId: "chat_run_long",
      runId: "run_long",
    }),
  ).toBe(true);
});

it("lists a parent and its subagents that shared the workspace", async () => {
  const burst = T0 + 30 * MINUTE;
  acquire("run_parent", T0);
  acquire("run_child", T0 + 5 * MINUTE, { kind: "subagent" });
  await expect(summary(burst)).resolves.toMatchObject({
    assessment: "several",
    parents: 1,
    subagents: 1,
  });
});

it("excludes runs that started after the burst or went quiet before its look-back", async () => {
  const burst = T0 + LOOK_BACK + 60 * MINUTE;
  acquire("run_old", T0);
  acquire("run_late", burst + 2 * MINUTE);
  await expect(summary(burst)).resolves.toMatchObject({
    assessment: "none",
    parents: 0,
    limitations: [],
  });
});

it("drops a record once its latest acquisition is past the retention", async () => {
  // Storage stays bounded in time: the first record is dropped before the run
  // acquires again, so acquisitions cannot place it across this burst.
  const burst = T0 + RETENTION - 30 * MINUTE;
  acquire("run_a", T0);
  acquire("run_a", T0 + RETENTION + MINUTE);
  await expect(summary(burst)).resolves.toMatchObject({ assessment: "none" });
});

it("keeps workspaces and accounts apart", async () => {
  const burst = T0 + 30 * MINUTE;
  acquire("run_a", T0);
  acquire("run_b", T0, { sandboxId: "sbx_2" });
  await expect(summary(burst)).resolves.toMatchObject({
    assessment: "one_possible",
    workspaces: 1,
  });
  // A burst counted on both workspaces lists both runs.
  await expect(summary(burst, ["sbx_1", "sbx_2"])).resolves.toMatchObject({
    assessment: "several",
    workspaces: 2,
  });
  const other = await readRunTimeline({
    region: "us",
    userId: "user_2",
    sandboxIds: ["sbx_1"],
    burstStart: burst,
    burstEnd: burst + MINUTE,
  });
  expect(other.summary).toMatchObject({ assessment: "none" });
});

it("labels only the windows an eviction could have changed", async () => {
  // More distinct runs than the bound: the least recently acquiring is evicted.
  for (let index = 0; index <= MAX_TIMELINE_RUNS; index++)
    acquire(`run_${index}`, T0 + index * MINUTE);
  expect(mockCommand("ZCARD", runsKey())).toBe(MAX_TIMELINE_RUNS);
  await expect(summary(T0 + 40 * MINUTE)).resolves.toMatchObject({
    assessment: "incomplete",
    limitations: ["evicted_in_window"],
  });
  // A later burst whose look-back starts after every evicted run's last
  // acquisition is unaffected while no new run appears after it.
  const later = T0 + LOOK_BACK + 40 * MINUTE;
  acquire("run_fresh", later - MINUTE);
  await expect(summary(later)).resolves.toMatchObject({
    assessment: "one_possible",
    limitations: [],
  });
  // A run first seen after that burst may be the evicted run acquiring again,
  // which could have spanned it.
  acquire("run_0", later + 10 * MINUTE);
  await expect(summary(later)).resolves.toMatchObject({
    assessment: "incomplete",
    limitations: ["evicted_in_window"],
  });
  // Beyond the retention, the original record would have been dropped too.
  const distant = T0 + RETENTION + 60 * MINUTE;
  acquire("run_new", distant + 10 * MINUTE);
  await expect(summary(distant)).resolves.toMatchObject({
    limitations: [],
  });
});

it("labels an unreadable record and keeps the others", async () => {
  const burst = T0 + 30 * MINUTE;
  acquire("run_a", T0);
  mockCommand("ZADD", runsKey(), T0 + 1, "p|chat_x|run_x|corrupt");
  await expect(summary(burst)).resolves.toMatchObject({
    assessment: "incomplete",
    parents: 1,
    limitations: ["invalid_record"],
  });
});

it("keeps the earliest first acquisition from an out-of-order write", async () => {
  const burst = T0 + 30 * MINUTE;
  acquire("run_a", burst + 5 * MINUTE);
  acquire("run_a", T0);
  await expect(summary(burst)).resolves.toMatchObject({
    assessment: "one_possible",
    acquiredAfterBurst: 1,
  });
  expect(mockCommand("ZCARD", runsKey())).toBe(1);
});
