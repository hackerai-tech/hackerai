import type { AnySandbox } from "@/types";
import { createBrowserHandoff } from "../../browser-handoff";
import {
  BROWSER_SESSION_MAX_LIFETIME_MS,
  BrowserSessions,
} from "../browser-sessions";

const mockQuery = jest.fn();
const mockMutation = jest.fn(async () => true);
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockQuery, mutation: mockMutation }),
}));

async function owner(agentId = "parent") {
  const sessions = new BrowserSessions({
    userId: "owner",
    chatId: "chat",
    runId: "run",
    agentId,
    serviceKey: "test-key",
  });
  const run = jest.fn(async () => ({ exitCode: 0, stdout: "/usr/bin" }));
  await sessions.prepare({
    sandboxId: agentId,
    commands: { run },
  } as unknown as AnySandbox);
  return { sessions, run };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockQuery.mockReset();
  mockMutation.mockReset().mockResolvedValue(true);
});
afterEach(() => jest.useRealTimers());

it.each(["waiting", "claiming", "human", "recovery", "resuming"])(
  "holds Agent progression in %s until explicit resume",
  async (state) => {
    const { sessions } = await owner();
    mockQuery.mockResolvedValue({ state, runActive: true });
    const progressed = jest.fn();
    const pending = sessions.waitForAgentControl().then(progressed);
    await jest.advanceTimersByTimeAsync(3000);
    expect(progressed).not.toHaveBeenCalled();
    mockQuery.mockResolvedValue({ state: "agent", runActive: true });
    await jest.advanceTimersByTimeAsync(1000);
    await pending;
    expect(progressed).toHaveBeenCalledWith(true);
  },
);

it("waits through takeover and resumes within one check without a sandbox sleep", async () => {
  const { sessions, run } = await owner();
  let state = "agent";
  mockQuery.mockImplementation(async () => ({
    state,
    runActive: true,
    updatedAt: 123,
  }));
  mockMutation.mockImplementation(async () => {
    state = "waiting";
    return true;
  });
  const tool = createBrowserHandoff(sessions);
  const finished = jest.fn();
  const pending = tool.execute!({}, { toolCallId: "handoff", messages: [] });
  const result = Promise.resolve(pending).then(finished);
  for (const next of ["waiting", "claiming", "human", "recovery", "resuming"]) {
    await jest.advanceTimersByTimeAsync(0);
    state = next;
    await jest.advanceTimersByTimeAsync(2000);
    expect(finished).not.toHaveBeenCalled();
  }
  // The resume API commits this only after saving the note and unpausing.
  state = "agent";
  await jest.advanceTimersByTimeAsync(1000);
  await result;
  expect(finished).toHaveBeenCalledWith(
    expect.objectContaining({ status: "resumed" }),
  );
  expect(run).toHaveBeenCalledTimes(1); // preparation only, no foreground wait
  expect(jest.getTimerCount()).toBe(0);
});

it("Stop interrupts the dedicated wait and never reports a successful handoff", async () => {
  const { sessions } = await owner();
  mockQuery.mockResolvedValue({
    state: "waiting",
    runActive: true,
    updatedAt: 1,
  });
  const stop = new AbortController();
  const pending = sessions.waitForHumanHandoff(stop.signal);
  const rejected = expect(pending).rejects.toThrow("Stopped by user");
  await jest.advanceTimersByTimeAsync(1000);
  stop.abort(new Error("Stopped by user"));
  await rejected;
  expect(jest.getTimerCount()).toBe(0);
});

it.each([undefined, true])(
  "passes the explicit repeat request (%s) through the tool to wait admission",
  async (requestAnotherTakeover) => {
    const { sessions } = await owner();
    mockQuery.mockResolvedValue({
      state: "agent",
      runActive: true,
      updatedAt: 123,
    });
    mockMutation.mockClear();
    const tool = createBrowserHandoff(sessions);
    await expect(
      tool.execute!(
        { requestAnotherTakeover },
        { toolCallId: "handoff", messages: [] },
      ),
    ).resolves.toMatchObject({ status: "resumed" });
    const admission = mockMutation.mock.calls[0][1];
    expect(admission.requestAnotherTakeover).toBe(requestAnotherTakeover);
    expect(jest.getTimerCount()).toBe(0);
  },
);

it("does not overwrite a resume that wins the wait registration race", async () => {
  const { sessions } = await owner();
  mockQuery.mockResolvedValue({
    state: "agent",
    runActive: true,
    updatedAt: 1,
  });
  mockMutation.mockResolvedValue(false);
  await expect(sessions.waitForHumanHandoff()).rejects.toThrow(
    "ownership changed",
  );
  expect(jest.getTimerCount()).toBe(0);
});

it("rejects a dedicated wait without a current browser owner", async () => {
  const { sessions } = await owner();
  mockQuery.mockResolvedValue(null);
  mockMutation.mockClear();
  await expect(sessions.waitForHumanHandoff()).rejects.toThrow(
    "Open a browser",
  );
  expect(mockMutation).not.toHaveBeenCalled();
});

it("rejects handoff without an owning run scope", async () => {
  const sessions = new BrowserSessions();
  await expect(sessions.waitForHumanHandoff()).rejects.toThrow(
    "Browser handoff is unavailable for this run.",
  );
  expect(mockQuery).not.toHaveBeenCalled();
  expect(mockMutation).not.toHaveBeenCalled();
});

it("rejects an already stopped handoff without registering a wait", async () => {
  const sessions = new BrowserSessions({
    userId: "owner",
    chatId: "chat",
    runId: "run",
    agentId: "parent",
    serviceKey: "test-key",
  });
  const stop = new AbortController();
  stop.abort(new Error("Stopped by user"));
  const pending = sessions.waitForHumanHandoff(stop.signal);
  const rejected = expect(pending).rejects.toThrow("Stopped by user");
  await rejected;
  expect(mockQuery).not.toHaveBeenCalled();
  expect(mockMutation).not.toHaveBeenCalled();
});

it("Stop interrupts a paused Agent and cleanup remains available", async () => {
  const { sessions, run } = await owner();
  mockQuery.mockResolvedValue({ state: "human", runActive: true });
  const controller = new AbortController();
  const pending = sessions.waitForAgentControl(controller.signal);
  const rejected = expect(pending).rejects.toThrow("Stopped by user");
  await jest.advanceTimersByTimeAsync(0);
  controller.abort(new Error("Stopped by user"));
  await rejected;
  await sessions.cleanup();
  expect(run).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(0);
});

it.each([null, { state: "closed", runActive: false }])(
  "does not treat missing or ended ownership as permission to continue",
  async (state) => {
    const { sessions } = await owner();
    mockQuery.mockResolvedValue(state);
    await expect(sessions.waitForAgentControl()).rejects.toThrow(
      "ownership has ended",
    );
  },
);

it("does not execute tools when the ownership query fails", async () => {
  const { sessions } = await owner();
  mockQuery.mockRejectedValue(new Error("Unavailable"));
  const execute = jest.fn();
  const tools = sessions.guardTools({ action: { execute } });
  await expect(
    tools.action.execute!({}, { toolCallId: "call", messages: [] }),
  ).rejects.toThrow("Unavailable");
  expect(execute).not.toHaveBeenCalled();
});

it("discards an action queued during takeover, then permits a newly planned action", async () => {
  const { sessions } = await owner();
  mockQuery.mockResolvedValue({ state: "human", runActive: true });
  const execute = jest.fn(async () => ({ saved: true }));
  const tools = sessions.guardTools({ write_file: { execute } });
  const pending = tools.write_file.execute!(
    {},
    { toolCallId: "old", messages: [] },
  );
  await jest.advanceTimersByTimeAsync(1000);
  expect(execute).not.toHaveBeenCalled();
  mockQuery.mockResolvedValue({ state: "agent", runActive: true });
  await jest.advanceTimersByTimeAsync(1000);
  expect(await pending).toEqual({
    error: expect.stringContaining("not executed"),
  });
  expect(execute).not.toHaveBeenCalled();
  await expect(
    tools.write_file.execute!({}, { toolCallId: "new", messages: [] }),
  ).resolves.toEqual({ saved: true });
});

it("scopes pause checks to each owner's registered session", async () => {
  const parent = await owner();
  const child = await owner("child");
  const registrations = mockMutation.mock.calls as unknown as Array<
    [unknown, { sessionId: string; agentId: string }]
  >;
  const parentId = registrations.find(
    ([, args]) => args.agentId === "parent",
  )![1].sessionId;
  mockQuery.mockImplementation(async (_query, args) => ({
    state: args.sessionId === parentId ? "human" : "agent",
    runActive: true,
  }));
  const stop = new AbortController();
  const parentWait = parent.sessions.waitForAgentControl(stop.signal);
  const rejected = expect(parentWait).rejects.toThrow("stop");
  await expect(child.sessions.waitForAgentControl()).resolves.toBe(false);
  stop.abort(new Error("stop"));
  await rejected;
});

it("does not query or delay an Agent without a registered cloud browser", async () => {
  await expect(new BrowserSessions().waitForAgentControl()).resolves.toBe(
    false,
  );
  expect(mockQuery).not.toHaveBeenCalled();
});

it("Stop also interrupts an unavailable ownership service", async () => {
  const { sessions } = await owner();
  mockQuery.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = sessions.waitForAgentControl(controller.signal);
  const rejected = expect(pending).rejects.toThrow("Stopped");
  controller.abort(new Error("Stopped"));
  await rejected;
});

it("continues on the current replacement sandbox without admitting an obsolete owner", async () => {
  const { sessions } = await owner();
  await sessions.prepare({
    sandboxId: "replacement",
    commands: { run: async () => ({ exitCode: 0, stdout: "/usr/bin" }) },
  } as unknown as AnySandbox);
  const registrations = mockMutation.mock.calls as unknown as Array<
    [unknown, { sessionId: string }]
  >;
  const latestId = registrations.at(-1)![1].sessionId;
  mockQuery.mockImplementation(async (_query, args) =>
    args.sessionId === latestId ? { state: "agent", runActive: true } : null,
  );
  await expect(sessions.waitForAgentControl()).resolves.toBe(false);
  mockQuery.mockResolvedValue(null);
  await expect(sessions.waitForAgentControl()).rejects.toThrow(
    "ownership has ended",
  );
});

it("does not impose browser expiry on runs without a registered browser", async () => {
  const sessions = new BrowserSessions({
    userId: "owner",
    chatId: "chat",
    runId: "run",
    agentId: "parent",
    serviceKey: "test-key",
  });
  jest.setSystemTime(Date.now() + BROWSER_SESSION_MAX_LIFETIME_MS);
  await expect(sessions.waitForAgentControl()).resolves.toBe(false);
  await expect(
    sessions.prepare({ sandboxKind: "centrifugo" } as unknown as AnySandbox),
  ).resolves.toEqual({});
  expect(mockQuery).not.toHaveBeenCalled();
  await sessions.cleanup();
  await expect(sessions.waitForAgentControl()).rejects.toThrow(
    "ownership has ended",
  );
});

it("supports browser setup late in a six-hour run but enforces final expiry", async () => {
  const startedAt = Date.now();
  const sessions = new BrowserSessions({
    userId: "owner",
    chatId: "chat",
    runId: "run",
    agentId: "parent",
    serviceKey: "test-key",
  });
  const sandbox = {
    sandboxId: "late",
    commands: {
      run: jest.fn(async () => ({ exitCode: 0, stdout: "/usr/bin" })),
    },
  } as unknown as AnySandbox;
  jest.setSystemTime(startedAt + 5.75 * 60 * 60 * 1000);
  await sessions.prepare(sandbox);
  mockQuery.mockResolvedValue({ state: "agent", runActive: true });
  await expect(sessions.waitForAgentControl()).resolves.toBe(false);
  jest.setSystemTime(startedAt + BROWSER_SESSION_MAX_LIFETIME_MS);
  await expect(sessions.waitForAgentControl()).rejects.toThrow(
    "ownership has ended",
  );
  await expect(sessions.prepare(sandbox)).rejects.toThrow(
    "ownership has ended",
  );
});

it("settles a displaced browser owner as cancellation without executing its queued tool", async () => {
  const stop = new AbortController();
  const lost = jest.fn(() => stop.abort());
  const sessions = new BrowserSessions(
    {
      userId: "owner",
      chatId: "chat",
      runId: "old",
      agentId: "parent",
      serviceKey: "test-key",
    },
    lost,
  );
  await sessions.prepare({
    sandboxId: "test",
    commands: {
      run: jest.fn(async () => ({ exitCode: 0, stdout: "/usr/bin" })),
    },
  } as unknown as AnySandbox);
  mockQuery.mockResolvedValue({ runActive: false, state: "agent" });
  const execute = jest.fn();
  const guarded = sessions.guardTools(
    { command: { execute } } as any,
    stop.signal,
  );
  await expect(
    guarded.command.execute!({}, { toolCallId: "tool", messages: [] } as any),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(lost).toHaveBeenCalledTimes(1);
  expect(stop.signal.aborted).toBe(true);
  expect(execute).not.toHaveBeenCalled();
});
