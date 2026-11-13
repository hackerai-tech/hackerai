jest.mock("dockerfile-ast", () => ({}), { virtual: true });

import type { AnySandbox } from "@/types";
import { z } from "zod";
import {
  BROWSER_SESSION_MAX_LIFETIME_MS,
  BrowserSessions,
} from "../browser-sessions";

const mockQuery = jest.fn();
const mockMutation = jest.fn();
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockQuery, mutation: mockMutation }),
}));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { info: jest.fn() } }));

// The native daemon closes an idle browser after 15 minutes.
const KEEPALIVE_MS = 5 * 60 * 1000;
const scope = {
  userId: "owner",
  chatId: "chat",
  runId: "run",
  agentId: "parent",
  serviceKey: "test-key",
};
const connected = {
  exitCode: 0,
  stdout: JSON.stringify({
    success: true,
    data: { connected: true, port: 9223 },
  }),
};
const held = (state: string, runActive = true) => ({
  state,
  runActive,
  updatedAt: 1,
});

function cloudSandbox(sandboxId: string) {
  const run: jest.Mock = jest.fn(async () => ({
    exitCode: 0,
    stdout: "/usr/bin",
  }));
  return {
    run,
    sandbox: { sandboxId, commands: { run } } as unknown as AnySandbox,
  };
}

// Every command embeds the program text; match the quoted action argument.
const STATUS = "'status' '/dev/shm/hackerai-browser-";
const statusCalls = (run: jest.Mock) =>
  run.mock.calls.filter(([command]) => String(command).includes(STATUS));

async function owner() {
  const sessions = new BrowserSessions(scope);
  const { run, sandbox } = cloudSandbox("sandbox");
  await sessions.prepare(sandbox, "gate_only");
  run.mockClear().mockResolvedValue(connected);
  mockMutation.mockClear();
  return { sessions, run };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockQuery.mockReset();
  mockMutation.mockReset().mockResolvedValue(true);
});
afterEach(() => jest.useRealTimers());

it.each(["waiting", "human", "recovery"])(
  "keeps the %s browser alive immediately, then every five minutes until resume",
  async (state) => {
    const { sessions, run } = await owner();
    mockQuery.mockResolvedValue(held(state));
    const resumed = jest.fn();
    const pending = sessions.waitForAgentControl().then(resumed);
    await jest.advanceTimersByTimeAsync(0);
    expect(statusCalls(run)).toHaveLength(1);
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining(STATUS),
      expect.objectContaining({ timeoutMs: 2_000, requestTimeoutMs: 3_000 }),
    );
    await jest.advanceTimersByTimeAsync(KEEPALIVE_MS - 1);
    expect(statusCalls(run)).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(statusCalls(run)).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(KEEPALIVE_MS);
    expect(statusCalls(run)).toHaveLength(3);
    expect(resumed).not.toHaveBeenCalled();

    mockQuery.mockResolvedValue(held("agent"));
    await jest.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(resumed).toHaveBeenCalledWith(true);
    await jest.advanceTimersByTimeAsync(2 * KEEPALIVE_MS);
    // Only content-free status: no launch, reopen or page read.
    expect(run).toHaveBeenCalledTimes(3);
    expect(statusCalls(run)).toHaveLength(3);
    expect(jest.getTimerCount()).toBe(0);
  },
);

it("shares one pending keepalive and its cadence across model and tool waiters", async () => {
  const { sessions, run } = await owner();
  mockQuery.mockResolvedValue(held("human"));
  let finish!: (value: typeof connected) => void;
  run.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const execute = jest.fn();
  const tools = sessions.guardTools({
    first: { inputSchema: z.object({}), execute },
    second: { inputSchema: z.object({}), execute },
  });
  const model = sessions.waitForAgentControl();
  const first = tools.first.execute!({}, { toolCallId: "first", messages: [] });
  const second = tools.second.execute!(
    {},
    { toolCallId: "second", messages: [] },
  );
  // Still pending beyond the one-second ownership poll.
  await jest.advanceTimersByTimeAsync(2_000);
  expect(statusCalls(run)).toHaveLength(1);
  finish(connected);
  await jest.advanceTimersByTimeAsync(KEEPALIVE_MS - 2_001);
  expect(statusCalls(run)).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(1_000);
  expect(statusCalls(run)).toHaveLength(2);

  mockQuery.mockResolvedValue(held("agent"));
  await jest.advanceTimersByTimeAsync(1_000);
  await expect(model).resolves.toBe(true);
  for (const queued of [first, second])
    await expect(queued).resolves.toEqual({
      error: expect.stringContaining("not executed"),
    });
  expect(execute).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(0);
});

it.each([
  ["a rejected transport", () => Promise.reject(new Error("socket missing"))],
  ["a missing daemon", async () => ({ exitCode: 1, stdout: "" })],
  ["a hung status", () => new Promise(() => {})],
])(
  "rate-bounds keepalive after %s without admitting the queued action",
  async (_, status) => {
    const { sessions, run } = await owner();
    mockQuery.mockResolvedValue(held("human"));
    run.mockImplementation(status);
    const execute = jest.fn();
    const tools = sessions.guardTools({
      action: { inputSchema: z.object({}), execute },
    });
    const queued = Promise.resolve(
      tools.action.execute!({}, { toolCallId: "queued", messages: [] }),
    );
    const settled = jest.fn();
    queued.then(settled, settled);
    await jest.advanceTimersByTimeAsync(KEEPALIVE_MS - 1);
    expect(statusCalls(run)).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(KEEPALIVE_MS + 1_000);
    expect(statusCalls(run)).toHaveLength(3);
    // A failed check neither releases the hold nor requests recovery/reopen.
    expect(settled).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(mockMutation).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(3);

    mockQuery.mockResolvedValue(held("agent"));
    await jest.advanceTimersByTimeAsync(4_000);
    await expect(queued).resolves.toEqual({
      error: expect.stringContaining("not executed"),
    });
    expect(execute).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  },
);

it("does not start a keepalive after Stop detaches a pending ownership read", async () => {
  const { sessions, run } = await owner();
  let settle!: (value: unknown) => void;
  mockQuery.mockReturnValue(new Promise((resolve) => (settle = resolve)));
  const stop = new AbortController();
  const reason = new Error("Stopped by user");
  const pending = sessions.waitForAgentControl(stop.signal);
  stop.abort(reason);
  await expect(pending).rejects.toBe(reason);
  settle(held("human"));
  await jest.advanceTimersByTimeAsync(KEEPALIVE_MS);
  expect(run).not.toHaveBeenCalled();
});

it("detaches only the stopped waiter from a shared keepalive with its own deadline", async () => {
  const { sessions, run } = await owner();
  mockQuery.mockResolvedValue(held("human"));
  run.mockImplementation(() => new Promise(() => {}));
  const stop = new AbortController();
  const reason = new Error("Stopped by user");
  const stopped = sessions.waitForAgentControl(stop.signal);
  const rejected = expect(stopped).rejects.toBe(reason);
  await jest.advanceTimersByTimeAsync(0);
  expect(statusCalls(run)).toHaveLength(1);
  const resumed = jest.fn();
  const other = sessions.waitForAgentControl().then(resumed);
  await jest.advanceTimersByTimeAsync(0);
  const reads = mockQuery.mock.calls.length;

  stop.abort(reason);
  await rejected;
  // The first caller's Stop cannot end the attempt the other waiter shares.
  await jest.advanceTimersByTimeAsync(2_999);
  expect(mockQuery).toHaveBeenCalledTimes(reads);
  await jest.advanceTimersByTimeAsync(KEEPALIVE_MS - 3_000);
  expect(mockQuery.mock.calls.length).toBeGreaterThan(reads);
  expect(statusCalls(run)).toHaveLength(1);
  expect(resumed).not.toHaveBeenCalled();

  mockQuery.mockResolvedValue(held("agent"));
  await jest.advanceTimersByTimeAsync(1_000);
  await other;
  expect(resumed).toHaveBeenCalledWith(true);
  expect(run).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

it.each([
  [
    "cleanup",
    (sessions: BrowserSessions) => {
      void sessions.cleanup();
    },
  ],
  [
    "owner expiry",
    () => {
      jest.setSystemTime(Date.now() + BROWSER_SESSION_MAX_LIFETIME_MS);
    },
  ],
])(
  "does not touch the browser after %s ends ownership during the read",
  async (_, end) => {
    const info = jest.spyOn(console, "info").mockImplementation(() => {});
    const { sessions, run } = await owner();
    let settle!: (value: unknown) => void;
    mockQuery
      .mockReturnValueOnce(new Promise((resolve) => (settle = resolve)))
      .mockResolvedValue(held("human"));
    const pending = sessions.waitForAgentControl();
    const rejected = expect(pending).rejects.toThrow("ownership has ended");
    await jest.advanceTimersByTimeAsync(0);
    end(sessions);
    settle(held("human"));
    await jest.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(statusCalls(run)).toHaveLength(0);
    info.mockRestore();
  },
);

it("keeps only the current owner's held browser alive, never a stale sandbox", async () => {
  const sessions = new BrowserSessions(scope);
  const stale = cloudSandbox("stale");
  const current = cloudSandbox("current");
  await sessions.prepare(stale.sandbox);
  await sessions.prepare(current.sandbox);
  const ids = Object.fromEntries(
    mockMutation.mock.calls.map(([, args]) => [args.sandboxId, args.sessionId]),
  );
  stale.run.mockClear().mockResolvedValue(connected);
  current.run.mockClear().mockResolvedValue(connected);
  let currentState = "agent";
  mockQuery.mockImplementation(async (_query, { sessionId }) =>
    sessionId === ids.current
      ? held(currentState)
      : held("human", /* runActive */ false),
  );
  await expect(sessions.waitForAgentControl()).resolves.toBe(false);
  expect(stale.run).not.toHaveBeenCalled();
  expect(current.run).not.toHaveBeenCalled();

  currentState = "human";
  const stop = new AbortController();
  const pending = sessions.waitForAgentControl(stop.signal);
  const rejected = expect(pending).rejects.toThrow("stop");
  await jest.advanceTimersByTimeAsync(0);
  expect(statusCalls(current.run)).toHaveLength(1);
  expect(stale.run).not.toHaveBeenCalled();
  stop.abort(new Error("stop"));
  await rejected;
});

it("does not probe without a handoff scope or registered browser", async () => {
  const unscoped = new BrowserSessions();
  const local = cloudSandbox("unscoped");
  await unscoped.prepare(local.sandbox);
  mockMutation.mockResolvedValue(false);
  const unregistered = new BrowserSessions(scope);
  const viewerless = cloudSandbox("unregistered");
  await unregistered.prepare(viewerless.sandbox);
  local.run.mockClear();
  viewerless.run.mockClear();
  mockQuery.mockResolvedValue(held("human"));
  await expect(unscoped.waitForAgentControl()).resolves.toBe(false);
  await expect(unregistered.waitForAgentControl()).resolves.toBe(false);
  expect(mockQuery).not.toHaveBeenCalled();
  expect(local.run).not.toHaveBeenCalled();
  expect(viewerless.run).not.toHaveBeenCalled();
});

it("does not probe a browser the Agent controls", async () => {
  const { sessions, run } = await owner();
  mockQuery.mockResolvedValue(held("agent"));
  await expect(sessions.waitForAgentControl()).resolves.toBe(false);
  expect(run).not.toHaveBeenCalled();
});

it.each(["claiming", "resuming", "unrecognized"])(
  "holds a %s handoff without keepalive",
  async (state) => {
    const { sessions, run } = await owner();
    mockQuery.mockResolvedValue(held(state));
    const pending = sessions.waitForAgentControl();
    await jest.advanceTimersByTimeAsync(2_000);
    mockQuery.mockResolvedValue(held("agent"));
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe(true);
    expect(run).not.toHaveBeenCalled();
  },
);

it.each([null, held("human", false)])(
  "never probes a browser without a current owner: %j",
  async (state) => {
    const { sessions, run } = await owner();
    mockQuery.mockResolvedValue(state);
    await expect(sessions.waitForAgentControl()).rejects.toThrow(
      "ownership has ended",
    );
    expect(run).not.toHaveBeenCalled();
  },
);
