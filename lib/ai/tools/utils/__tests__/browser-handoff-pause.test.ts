import type { AnySandbox } from "@/types";
import { BrowserSessions } from "../browser-sessions";

const mockQuery = jest.fn();
const mockMutation = jest.fn(async () => true);
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockQuery, mutation: mockMutation }),
}));
jest.mock("@/lib/posthog/server", () => ({
  getPostHogBooleanFlagDecisionForUser: async () => true,
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
  mockMutation.mockClear();
});
afterEach(() => jest.useRealTimers());

it.each(["claiming", "human", "recovery", "resuming"])(
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
