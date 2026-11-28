/** @jest-environment node */
// Explicit Redis integration suite, run by CI after redis-server installation.
// The terminal start scripts execute unchanged in an isolated Redis; the
// binding, recorder and reader are the application code.
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
  MAX_STARTING_RUNS_PER_MINUTE,
  bindVerifiedTerminalWorkspace,
  readTerminalStarts,
  recordVerifiedTerminalStart,
} from "../../lib/abuse/egress-terminal-starts";

const MINUTE = 60_000;
// A minute boundary, so offsets below stay inside the intended minute.
const T0 = 28_333_333 * MINUTE;
const BURST = T0 + 60 * MINUTE;
let server: ChildProcess;
let directory: string;
const env = process.env;

/** A client object verified for one workspace and run, as at acquisition. */
const verify = (
  runId: string,
  now: number,
  options: {
    kind?: "parent" | "subagent";
    sandboxId?: string;
    userId?: string;
    region?: "us" | "eu";
    sandbox?: object;
  } = {},
) => {
  const sandbox = options.sandbox ?? {
    sandboxId: options.sandboxId ?? "sbx_1",
  };
  bindVerifiedTerminalWorkspace(sandbox, {
    region: options.region ?? "us",
    userId: options.userId ?? "user_1",
    sandboxId: (sandbox as { sandboxId: string }).sandboxId,
    chatId: `chat_${runId}`,
    runId,
    runKind: options.kind,
    now,
  });
  return sandbox;
};
/** Writes are not awaited by the recorder; redis-cli is synchronous. */
const started = (
  sandbox: object,
  runId: string,
  now: number,
  userId = "user_1",
) =>
  recordVerifiedTerminalStart(sandbox, {
    pid: 100,
    userId,
    chatId: `chat_${runId}`,
    runId,
    now,
  });
const read = (
  options: {
    sandboxIds?: string[];
    region?: "us" | "eu";
    userId?: string;
  } = {},
) =>
  readTerminalStarts({
    region: options.region ?? "us",
    userId: options.userId ?? "user_1",
    sandboxIds: options.sandboxIds ?? ["sbx_1"],
    burstStart: BURST,
    burstEnd: BURST + MINUTE,
  });
const summary = async (options?: Parameters<typeof read>[0]) =>
  (await read(options)).summary;

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
    E2B_EGRESS_TERMINAL_START_SHADOW_ENABLED: "true",
  };
});

it("distinguishes an unobserved workspace from one with no recorded starts", async () => {
  await expect(summary()).resolves.toMatchObject({
    assessment: "unobserved",
    limitations: ["workspace_unobserved"],
  });
  // Recording seen active only after the window began says nothing either.
  verify("run_a", BURST);
  await expect(summary()).resolves.toMatchObject({ assessment: "unobserved" });
  // An earlier verified acquisition keeps the earliest time.
  verify("run_a", T0);
  await expect(summary()).resolves.toMatchObject({
    assessment: "no_observed_starts",
    burstMinuteRuns: 0,
    limitations: [],
  });
});

it("counts runs in the burst minute separately from its margins", async () => {
  const a = verify("run_a", T0);
  const b = verify("run_b", T0, { kind: "subagent", sandbox: a });
  const c = verify("run_c", T0, { sandbox: a });
  started(a, "run_a", BURST + 30_000);
  started(b, "run_b", BURST - 1);
  started(c, "run_c", BURST + 2 * MINUTE);
  const result = await read();
  expect(result.summary).toEqual({
    status: "read",
    assessment: "several_runs",
    burstMinuteRuns: 1,
    marginOnlyRuns: 1,
    parents: 1,
    subagents: 1,
    workspaces: 1,
    limitations: [],
  });
  expect(
    result.started({ kind: "parent", chatId: "chat_run_a", runId: "run_a" }),
  ).toBe(true);
  expect(
    result.started({ kind: "parent", chatId: "chat_run_c", runId: "run_c" }),
  ).toBe(false);
  // Members are pseudonymous: no chat or run identifier is stored.
  const [key] = mockCommand("KEYS", "egress-review:starts:v1:*:m:*");
  expect(JSON.stringify(mockCommand("SMEMBERS", key))).not.toMatch(
    /run_|chat_/,
  );
});

it("keeps one member per run and minute across processes and retries", async () => {
  // Two client objects for the same run, as after a reconnect or in another
  // worker, each write once; the stored set still holds one run.
  for (const sandbox of [verify("run_a", T0), verify("run_a", T0)])
    for (let second = 0; second < 3; second++)
      started(sandbox, "run_a", BURST + second * 1_000);
  const [key] = mockCommand("KEYS", "egress-review:starts:v1:*:m:*");
  expect(mockCommand("SCARD", key)).toBe(1);
  await expect(summary()).resolves.toMatchObject({ assessment: "one_run" });
});

it("caps runs per minute with an explicit signal", async () => {
  const sandbox = verify("run_0", T0);
  for (let index = 0; index < MAX_STARTING_RUNS_PER_MINUTE; index++) {
    verify(`run_${index}`, T0, { sandbox });
    started(sandbox, `run_${index}`, BURST);
  }
  // A run already stored at the bound rewrites without a capped signal.
  started(verify("run_0", T0), "run_0", BURST);
  await expect(summary()).resolves.toMatchObject({
    assessment: "several_runs",
    burstMinuteRuns: MAX_STARTING_RUNS_PER_MINUTE,
    limitations: [],
  });
  for (const runId of ["run_extra", "run_extra2"]) {
    verify(runId, T0, { sandbox });
    started(sandbox, runId, BURST);
  }
  const [key] = mockCommand("KEYS", "egress-review:starts:v1:*:m:*");
  expect(mockCommand("SCARD", key)).toBe(MAX_STARTING_RUNS_PER_MINUTE + 1);
  await expect(summary()).resolves.toMatchObject({
    assessment: "partial",
    burstMinuteRuns: MAX_STARTING_RUNS_PER_MINUTE,
    limitations: ["capped"],
  });
});

it("keeps workspaces, accounts and regions apart", async () => {
  verify("run_a", T0);
  started(verify("run_b", T0, { sandboxId: "sbx_2" }), "run_b", BURST);
  started(verify("run_c", T0, { userId: "user_2" }), "run_c", BURST, "user_2");
  started(verify("run_d", T0, { region: "eu" }), "run_d", BURST);
  await expect(summary()).resolves.toMatchObject({
    assessment: "no_observed_starts",
  });
  await expect(
    summary({ sandboxIds: ["sbx_1", "sbx_2"] }),
  ).resolves.toMatchObject({
    assessment: "one_run",
    workspaces: 2,
  });
});

it("expires its keys on the short telemetry retention", async () => {
  started(verify("run_a", T0), "run_a", BURST);
  for (const key of mockCommand("KEYS", "egress-review:starts:v1:*"))
    expect(mockCommand("TTL", key)).toBeLessThanOrEqual(150 * 60);
});

it("reports a malformed stored member as partial", async () => {
  started(verify("run_a", T0), "run_a", BURST);
  const [key] = mockCommand("KEYS", "egress-review:starts:v1:*:m:*");
  mockCommand("SADD", key, "run_raw");
  await expect(summary()).resolves.toMatchObject({
    assessment: "partial",
    burstMinuteRuns: 1,
    limitations: ["invalid_record"],
  });
});

it("reports an oversized stored minute without counting its members", async () => {
  started(verify("run_a", T0), "run_a", BURST);
  const [key] = mockCommand("KEYS", "egress-review:starts:v1:*:m:*");
  const overflow = Array.from(
    { length: MAX_STARTING_RUNS_PER_MINUTE + 1 },
    (_, index) => `p${index.toString(16).padStart(24, "0")}`,
  );
  mockCommand("SADD", key, ...overflow);
  await expect(summary()).resolves.toMatchObject({
    assessment: "partial",
    burstMinuteRuns: 0,
    limitations: ["invalid_record"],
  });
});
