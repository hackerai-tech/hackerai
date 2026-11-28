/** @jest-environment node */
jest.mock("@/lib/rate-limit/redis", () => ({ createRedisClient: jest.fn() }));

import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  bindVerifiedTerminalWorkspace,
  readTerminalStarts,
  recordVerifiedTerminalStart,
} from "../egress-terminal-starts";

// The scripts run against real Redis in
// scripts/tests/egress-terminal-starts.integration.ts; these cover which
// starts are written at all, and what happens when the store misbehaves.
const flush = () => new Promise((resolve) => setImmediate(resolve));
const originalEnv = process.env;
const T = 1_800_000_000_000;
const verified = {
  region: "us" as const,
  userId: "user_1",
  sandboxId: "sbx_1",
  chatId: "chat_1",
  runId: "run_1",
};
const start = (overrides: Record<string, unknown> = {}) => ({
  pid: 42,
  userId: "user_1",
  chatId: "chat_1",
  runId: "run_1",
  now: T,
  ...overrides,
});
let redis: { eval: jest.Mock };
/** Start writes carry a minute key; binding writes only the since key. */
const startWrites = () =>
  redis.eval.mock.calls.filter(([, keys]) => keys.length === 2);
const bound = () => {
  const sandbox = { sandboxId: "sbx_1" };
  bindVerifiedTerminalWorkspace(sandbox, { ...verified, now: T - 60_000 });
  return sandbox;
};

beforeEach(() => {
  process.env = {
    ...originalEnv,
    E2B_EGRESS_ABUSE_REVIEW_ENABLED: "true",
    E2B_EGRESS_TERMINAL_START_SHADOW_ENABLED: "true",
  };
  redis = { eval: jest.fn(async () => 1) };
  jest
    .mocked(createRedisClient)
    .mockReset()
    .mockReturnValue(redis as never);
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  process.env = originalEnv;
});

it.each([
  [
    "the shadow switch is unset",
    { E2B_EGRESS_TERMINAL_START_SHADOW_ENABLED: "" },
  ],
  [
    "the shadow switch is invalid",
    { E2B_EGRESS_TERMINAL_START_SHADOW_ENABLED: "1" },
  ],
  ["the review is off", { E2B_EGRESS_ABUSE_REVIEW_ENABLED: "false" }],
])("touches no store while %s", async (_label, env) => {
  Object.assign(process.env, env);
  const sandbox = bound();
  recordVerifiedTerminalStart(sandbox, start());
  await expect(
    readTerminalStarts({
      region: "us",
      userId: "user_1",
      sandboxIds: ["sbx_1"],
      burstStart: T,
      burstEnd: T + 60_000,
    }),
  ).resolves.toMatchObject({ summary: { status: "disabled" } });
  expect(createRedisClient).not.toHaveBeenCalled();
});

it("writes one start per run and minute for the verified owner and run only", async () => {
  const sandbox = bound();
  recordVerifiedTerminalStart(sandbox, start());
  recordVerifiedTerminalStart(sandbox, start({ now: T + 59_999 }));
  recordVerifiedTerminalStart(sandbox, start({ now: T + 60_000 }));
  // Another account, run or chat on the same object, an invalid PID, a
  // client this process never verified, and a request without a server run.
  recordVerifiedTerminalStart(sandbox, start({ userId: "user_2" }));
  recordVerifiedTerminalStart(sandbox, start({ runId: "run_2" }));
  recordVerifiedTerminalStart(sandbox, start({ chatId: "chat_2" }));
  for (const pid of [0, -1, 1.5, undefined, "42"])
    recordVerifiedTerminalStart(sandbox, start({ pid, now: T + 120_000 }));
  recordVerifiedTerminalStart({ sandboxId: "sbx_1" }, start());
  recordVerifiedTerminalStart(sandbox, start({ runId: undefined }));
  await flush();
  expect(startWrites().map(([, [, minute]]) => minute)).toEqual([
    expect.stringMatching(new RegExp(`:m:${T / 60_000}$`)),
    expect.stringMatching(new RegExp(`:m:${T / 60_000 + 1}$`)),
  ]);
});

it("never binds without a server chat and run", () => {
  const sandbox = { sandboxId: "sbx_1" };
  bindVerifiedTerminalWorkspace(sandbox, { ...verified, runId: undefined });
  recordVerifiedTerminalStart(sandbox, start());
  expect(redis.eval).not.toHaveBeenCalled();
});

it("reads the same keys it wrote only for the verified region and owner", async () => {
  const sandbox = bound();
  recordVerifiedTerminalStart(sandbox, start());
  await flush();
  const [[, [since, minute]]] = startWrites();
  const readKeys = async (region: "us" | "eu", userId: string) => {
    redis.eval.mockClear();
    await readTerminalStarts({
      region,
      userId,
      sandboxIds: ["sbx_1"],
      burstStart: T,
      burstEnd: T + 60_000,
    });
    return redis.eval.mock.calls[0][1] as string[];
  };
  // Since, then the burst minute with one margin minute on each side.
  expect(await readKeys("us", "user_1")).toEqual([
    since,
    minute.replace(/\d+$/, String(T / 60_000 - 1)),
    minute,
    minute.replace(/\d+$/, String(T / 60_000 + 1)),
  ]);
  for (const other of [
    await readKeys("eu", "user_1"),
    await readKeys("us", "user_2"),
  ])
    expect(other).not.toContain(minute);
});

it("lets a later command retry a failed write in the same minute", async () => {
  const sandbox = bound();
  redis.eval.mockClear().mockRejectedValueOnce(new Error("store down"));
  recordVerifiedTerminalStart(sandbox, start());
  await flush();
  recordVerifiedTerminalStart(sandbox, start({ now: T + 1 }));
  recordVerifiedTerminalStart(sandbox, start({ now: T + 2 }));
  await flush();
  expect(startWrites()).toHaveLength(2);
  expect(console.warn).toHaveBeenCalledWith(
    JSON.stringify({ event: "egress_terminal_start_record_unavailable" }),
  );
});

it("allows a retry without throwing into the command path after a synchronous store failure", async () => {
  const sandbox = bound();
  redis.eval.mockImplementationOnce(() => {
    throw new Error("store down");
  });
  expect(() => recordVerifiedTerminalStart(sandbox, start())).not.toThrow();
  await flush();
  recordVerifiedTerminalStart(sandbox, start({ now: T + 1 }));
  expect(startWrites()).toHaveLength(2);
});

it.each([
  [
    "the store is missing",
    () => jest.mocked(createRedisClient).mockReturnValue(null),
  ],
  ["every read fails", () => redis.eval.mockRejectedValue(new Error("down"))],
])("reports unavailable when %s", async (_label, arrange) => {
  arrange();
  await expect(
    readTerminalStarts({
      region: "us",
      userId: "user_1",
      sandboxIds: ["sbx_1"],
      burstStart: T,
      burstEnd: T + 60_000,
    }),
  ).resolves.toMatchObject({ summary: { status: "unavailable" } });
});

it("marks a partial read when one workspace fails or more are verified than read", async () => {
  const empty = [String(T - 3_600_000), [], [], []];
  redis.eval.mockRejectedValueOnce(new Error("down")).mockResolvedValue(empty);
  const read = await readTerminalStarts({
    region: "us",
    userId: "user_1",
    sandboxIds: ["a", "b", "c", "d", "e"],
    burstStart: T,
    burstEnd: T + 60_000,
  });
  expect(redis.eval).toHaveBeenCalledTimes(4);
  expect(read.summary).toMatchObject({
    status: "read",
    assessment: "partial",
    workspaces: 3,
    limitations: ["workspace_unavailable", "workspaces_capped"],
  });
});

it("rejects an invalid burst window before asking the store for minute keys", async () => {
  await expect(
    readTerminalStarts({
      region: "us",
      userId: "user_1",
      sandboxIds: ["sbx_1"],
      burstStart: T,
      burstEnd: T + 120_000,
    }),
  ).resolves.toMatchObject({ summary: { status: "unavailable" } });
  expect(createRedisClient).not.toHaveBeenCalled();
});
