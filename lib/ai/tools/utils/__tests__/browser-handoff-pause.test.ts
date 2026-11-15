// The SDK template builder imports an ESM parser unused by this error test.
jest.mock("dockerfile-ast", () => ({}), { virtual: true });

import {
  extractErrorDetails,
  isRetriableProviderStreamDisconnectError,
} from "@/lib/utils/error-utils";
import { wrapProviderTerminalError } from "@/lib/api/provider-terminal-error";
import type { AnySandbox } from "@/types";
import { getFunctionName } from "convex/server";
import { CommandExitError } from "@e2b/code-interpreter";
import { createBrowserHandoff } from "../../browser-handoff";
import { phLogger } from "@/lib/posthog/server";
import {
  BROWSER_SESSION_MAX_LIFETIME_MS,
  BrowserSessions,
} from "../browser-sessions";

const mockNameGetter = jest.fn(() => {
  throw new Error("DO_NOT_LOG name getter must not run");
});
const mockQuery = jest.fn();
const mockMutation = jest.fn(async () => true);
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockQuery, mutation: mockMutation }),
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { info: jest.fn() },
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
  const read = jest.fn(async () => "default");
  await sessions.prepare({
    sandboxId: agentId,
    commands: { run },
    files: { read },
  } as unknown as AnySandbox);
  run.mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({
      success: true,
      data: { connected: true, port: 9223 },
    }),
  });
  return { sessions, run, read };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockQuery.mockReset();
  mockMutation.mockReset().mockResolvedValue(true);
  jest.mocked(phLogger.info).mockReset();
});
afterEach(() => jest.useRealTimers());

it.each([
  ["connected", { success: true, data: { connected: true, port: 9223 } }],
  ["disconnected", { success: true, data: { connected: false } }],
  ["invalid_response", { success: true, data: { connected: true, port: 0 } }],
  ["invalid_response", "DO_NOT_LOG https://private.example/page"],
  ["command_failed", null],
  [
    "command_failed",
    new CommandExitError({
      exitCode: 2,
      stdout: "DO_NOT_LOG private stdout",
      stderr: "DO_NOT_LOG private stderr",
      error: "DO_NOT_LOG private error",
    }),
  ],
  ["transport_error", new Error("DO_NOT_LOG transport error")],
  [
    "transport_error",
    Object.defineProperty(new Error("DO_NOT_LOG getter"), "name", {
      get: mockNameGetter,
    }),
  ],
  [
    "transport_error",
    new Proxy(new Error("DO_NOT_LOG proxy"), {
      getOwnPropertyDescriptor() {
        throw new Error("DO_NOT_LOG descriptor unavailable");
      },
    }),
  ],
] as const)(
  "records finite admission liveness %s without changing accepted handoff behavior",
  async (expected, response) => {
    const { sessions, run } = await owner();
    mockQuery.mockResolvedValue({
      state: "agent",
      runActive: true,
      updatedAt: 123,
    });
    mockMutation.mockClear();
    if (response instanceof Error) run.mockRejectedValue(response);
    else
      run.mockResolvedValue({
        exitCode: response === null ? 1 : 0,
        stdout:
          typeof response === "string" ? response : JSON.stringify(response),
      });
    await expect(sessions.waitForHumanHandoff()).resolves.toBeUndefined();
    expect(mockMutation.mock.calls[0][1]).toMatchObject({
      expectedUpdatedAt: 123,
    });
    expect(phLogger.info).toHaveBeenCalledWith(
      "browser_handoff_admission_diagnostics",
      expect.objectContaining({
        diagnostic_version: 3,
        admission_env_idle_timeout: "unavailable",
        admission_probe_result: expected,
        admission_probe_attempt: 1,
        admission_request_accepted: true,
        admission_observation_phase: "after_accepted_wait_request",
        admission_state_before: "agent",
        admission_owner_remaining: "gte_10m",
        admission_request_another: false,
        trigger_run_id: "run",
        agent_id: "parent",
        browser_session_id: expect.stringMatching(/^[a-f0-9]{32}$/),
      }),
    );
    expect(JSON.stringify(jest.mocked(phLogger.info).mock.calls)).not.toMatch(
      /DO_NOT_LOG|private\.example|test-key|stdout|stderr|\/dev\/shm/,
    );
    expect(
      Object.keys(
        jest
          .mocked(phLogger.info)
          .mock.calls.find(
            ([event]) => event === "browser_handoff_admission_diagnostics",
          )![1]!,
      ).sort(),
    ).toEqual([
      "admission_env_idle_timeout",
      "admission_observation_phase",
      "admission_owner_remaining",
      "admission_probe_attempt",
      "admission_probe_result",
      "admission_request_accepted",
      "admission_request_another",
      "admission_state_before",
      "agent_id",
      "browser_session_id",
      "diagnostic_version",
      "trigger_run_id",
    ]);
    expect(mockNameGetter).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  },
);

it.each([
  ["15m", "15m"],
  ["PRIVATE_VALUE", "unavailable"],
])(
  "projects only a finite ambient idle bucket (%s)",
  async (bucket, expected) => {
    const { sessions, run } = await owner();
    mockQuery.mockResolvedValue({
      state: "agent",
      runActive: true,
      updatedAt: 123,
    });
    run.mockClear().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        success: true,
        data: { connected: true, port: 9223 },
        hackerai_env_idle_timeout: bucket,
      }),
    });
    await expect(sessions.waitForHumanHandoff()).resolves.toBeUndefined();
    expect(phLogger.info).toHaveBeenCalledWith(
      "browser_handoff_admission_diagnostics",
      expect.objectContaining({
        diagnostic_version: 3,
        admission_probe_result: "connected",
        admission_env_idle_timeout: expected,
      }),
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(jest.mocked(phLogger.info).mock.calls)).not.toContain(
      "PRIVATE_VALUE",
    );
  },
);

it("keeps the observation outside the ownership read/write race window", async () => {
  const { sessions, run } = await owner();
  let version = 123;
  mockQuery.mockImplementation(async () => ({
    state: "agent",
    runActive: true,
    updatedAt: version,
  }));
  mockMutation.mockClear();
  mockMutation.mockImplementation(
    async (_fn, args) => args.expectedUpdatedAt === version,
  );
  let finish!: () => void;
  run.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ exitCode: 0, stdout: "{}" });
      }),
  );
  const pending = sessions.waitForHumanHandoff();
  await jest.advanceTimersByTimeAsync(0);
  expect(mockMutation.mock.calls[0][1].expectedUpdatedAt).toBe(123);
  version = 456;
  finish();
  await expect(pending).resolves.toBeUndefined();
  expect(mockMutation).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

it("caps admission observation across repeated handoffs without capping admission", async () => {
  const { sessions, run } = await owner();
  mockQuery.mockResolvedValue({
    state: "agent",
    runActive: true,
    updatedAt: 123,
  });
  mockMutation.mockClear();
  for (let i = 0; i < 4; i++)
    await sessions.waitForHumanHandoff(undefined, true);
  expect(mockMutation).toHaveBeenCalledTimes(4);
  expect(run).toHaveBeenCalledTimes(5); // preparation and one check per new wait
  expect(
    jest
      .mocked(phLogger.info)
      .mock.calls.filter(
        ([event]) => event === "browser_handoff_admission_diagnostics",
      ),
  ).toHaveLength(2);
  expect(jest.getTimerCount()).toBe(0);
});

it("bounds a hung observation and admits after a censored deadline", async () => {
  const { sessions, run } = await owner();
  mockQuery.mockResolvedValue({
    state: "agent",
    runActive: true,
    updatedAt: 123,
  });
  mockMutation.mockClear();
  run.mockImplementation(() => new Promise(() => {}));
  const pending = sessions.waitForHumanHandoff();
  await jest.advanceTimersByTimeAsync(0);
  await jest.advanceTimersByTimeAsync(2999);
  expect(mockMutation).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  await pending;
  expect(mockMutation).toHaveBeenCalledTimes(1);
  expect(phLogger.info).toHaveBeenCalledWith(
    "browser_handoff_admission_diagnostics",
    expect.objectContaining({ admission_probe_result: "deadline" }),
  );
  expect(jest.getTimerCount()).toBe(0);
});

it("honors Stop during the observation without reporting a completed handoff", async () => {
  const { sessions, run } = await owner();
  mockQuery.mockResolvedValue({
    state: "agent",
    runActive: true,
    updatedAt: 123,
  });
  mockMutation.mockClear();
  run.mockImplementation(() => new Promise(() => {}));
  const stop = new AbortController();
  const pending = sessions.waitForHumanHandoff(stop.signal);
  const rejected = expect(pending).rejects.toThrow("Stopped by user");
  await jest.advanceTimersByTimeAsync(0);
  stop.abort(new Error("Stopped by user"));
  await rejected;
  expect(mockMutation).toHaveBeenCalledTimes(1);
  expect(phLogger.info).not.toHaveBeenCalledWith(
    "browser_handoff_admission_diagnostics",
    expect.anything(),
  );
  expect(jest.getTimerCount()).toBe(0);
});

it("does not let optional admission logging prevent accepted control flow", async () => {
  const { sessions } = await owner();
  mockQuery.mockResolvedValue({
    state: "agent",
    runActive: true,
    updatedAt: 123,
  });
  jest.mocked(phLogger.info).mockImplementation(() => {
    throw new Error("logging unavailable");
  });
  await expect(sessions.waitForHumanHandoff()).resolves.toBeUndefined();
  expect(jest.getTimerCount()).toBe(0);
});

it("only permits recovery for this run's already connected private browser", async () => {
  const { sessions, run } = await owner();
  mockQuery.mockResolvedValue({ runActive: true, state: "agent" });
  run.mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({
      success: true,
      data: { connected: true, port: 9223 },
    }),
  });
  await expect(sessions.canRecoverHumanHandoff()).resolves.toBe(true);
  expect(run).toHaveBeenLastCalledWith(
    expect.stringContaining("'status' '/dev/shm/hackerai-browser-"),
    expect.objectContaining({ user: "root", timeoutMs: 5000 }),
  );
});

it.each([
  { connected: false, port: 9223 },
  { connected: true },
  { connected: true, port: 0 },
  { connected: true, port: 65536 },
])("does not recover a missing or disconnected stream: %j", async (data) => {
  const { sessions, run } = await owner();
  mockQuery.mockResolvedValue({ runActive: true });
  run.mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({ success: true, data }),
  });
  await expect(sessions.canRecoverHumanHandoff()).resolves.toBe(false);
});

it("does not inspect another owner's browser or reopen a closed one", async () => {
  const { sessions, run } = await owner();
  mockQuery.mockResolvedValue({ runActive: false });
  await expect(sessions.canRecoverHumanHandoff()).resolves.toBe(false);
  expect(run).toHaveBeenCalledTimes(1); // preparation only
  mockQuery.mockResolvedValue({ runActive: true });
  run.mockRejectedValue(new Error("active session removed"));
  await expect(sessions.canRecoverHumanHandoff()).resolves.toBe(false);
  expect(run).toHaveBeenCalledTimes(2);
});

it("stops a pending recovery probe without admitting a wait", async () => {
  const { sessions, read } = await owner();
  mockQuery.mockReturnValue(new Promise(() => {}));
  const stop = new AbortController();
  const probe = sessions.canRecoverHumanHandoff(stop.signal);
  stop.abort();
  await expect(probe).resolves.toBe(false);
  expect(read).not.toHaveBeenCalled();
});

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
  const pending = tool.execute!(
    { reason: "The user requested browser control." },
    { toolCallId: "handoff", messages: [] },
  );
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
  // Preparation, bounded observation and one held-browser keepalive status;
  // no foreground wait.
  expect(run).toHaveBeenCalledTimes(3);
  expect(run).toHaveBeenLastCalledWith(
    expect.stringContaining("'status' '/dev/shm/hackerai-browser-"),
    expect.objectContaining({ timeoutMs: 2_000 }),
  );
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
        {
          reason: "The user requested browser control.",
          requestAnotherTakeover,
        },
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
  expect(phLogger.info).not.toHaveBeenCalledWith(
    "browser_handoff_admission_diagnostics",
    expect.anything(),
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
  // Preparation, the held browser's first keepalive status, then cleanup.
  expect(run).toHaveBeenCalledTimes(3);
  expect(run).toHaveBeenLastCalledWith(
    expect.stringContaining("'cleanup' '/dev/shm/hackerai-browser-"),
    expect.anything(),
  );
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

it.each(["waitForAgentControl", "getExitNotes"] as const)(
  "retains %s read provenance without changing the transport failure or retry eligibility",
  async (readMethod) => {
    const { sessions } = await owner();
    const failure = Object.freeze(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("read ECONNRESET"), {
          code: "ECONNRESET",
        }),
      }),
    );
    const eligibleBefore = isRetriableProviderStreamDisconnectError(failure);
    mockQuery.mockRejectedValue(failure);
    await expect(sessions[readMethod]()).rejects.toBe(failure);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(extractErrorDetails(failure)).toMatchObject({
      errorOrigin: "browser_handoff_read",
      errorCode: "ECONNRESET",
    });
    expect(isRetriableProviderStreamDisconnectError(failure)).toBe(
      eligibleBefore,
    );
    const terminal = wrapProviderTerminalError(failure, {
      model: "previous/model",
      openRouterMetadata: {
        provider_name: "Together",
        openrouter_selected_model: "previous/model",
        openrouter_generation_id: "gen-previous",
        openrouter_request_id: "request-previous",
        openrouter_upstream_id: "upstream-previous",
      },
    });
    expect(terminal).toMatchObject({
      origin: "browser_handoff_read",
      provider: "unknown",
      model: "unknown",
      category: "stream_terminated",
      cause: failure,
    });
    expect(terminal.message).toContain("origin=browser_handoff_read");
    expect(terminal.openrouterGenerationId).toBeUndefined();
    expect(terminal.openrouterRequestId).toBeUndefined();
    expect(terminal.openrouterUpstreamId).toBeUndefined();
  },
);

it("keeps Stop separate from a later rejected browser safety read", async () => {
  const { sessions } = await owner();
  let rejectRead!: (error: Error) => void;
  mockQuery.mockReturnValue(
    new Promise((_, reject) => {
      rejectRead = reject;
    }),
  );
  const stop = new AbortController();
  const reason = new Error("Stopped by user");
  const pending = sessions.waitForAgentControl(stop.signal);
  stop.abort(reason);
  await expect(pending).rejects.toBe(reason);
  rejectRead(new Error("read ECONNRESET"));
  await jest.advanceTimersByTimeAsync(0);
  expect(extractErrorDetails(reason).errorOrigin).toBeUndefined();
  expect(mockQuery).toHaveBeenCalledTimes(1);
});

describe("browser read summaries", () => {
  let info: jest.SpyInstance;
  beforeEach(() => {
    info = jest.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => info.mockRestore());

  const summaries = () =>
    info.mock.calls.flatMap(([line]) => {
      if (typeof line !== "string" || !line.startsWith("{")) return [];
      const value = JSON.parse(line);
      return value.event === "browser_handoff_read_summary" ? [value] : [];
    });

  it("counts logical reads at every browser boundary once without logging private data", async () => {
    const { sessions, run } = await owner();
    const notes = [{ id: "note-id", text: "private handoff instructions" }];
    mockQuery.mockImplementation(async (reference) =>
      getFunctionName(reference).endsWith("getExitNotesForBackend")
        ? notes
        : { state: "agent", runActive: true, updatedAt: 123 },
    );
    run.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        success: true,
        data: { connected: true, port: 9223 },
      }),
    });
    await expect(sessions.canRecoverHumanHandoff()).resolves.toBe(true);
    await sessions.waitForHumanHandoff();
    const execute = jest.fn(async () => "done");
    const guarded = sessions.guardTools({ command: { execute } } as any);
    await expect(
      guarded.command.execute!({}, { toolCallId: "tool", messages: [] } as any),
    ).resolves.toBe("done");
    await expect(sessions.getExitNotes()).resolves.toEqual(notes);
    await sessions.cleanup();
    await sessions.cleanup();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(summaries()).toEqual([
      {
        event: "browser_handoff_read_summary",
        trigger_run_id: "run",
        agent_id: "parent",
        summary_phase: "cleanup_start",
        counts_unit: "logical_query",
        state_read_calls: 4,
        state_read_succeeded: 4,
        state_read_rejected: 0,
        state_read_pending: 0,
        note_read_calls: 1,
        note_read_succeeded: 1,
        note_read_rejected: 0,
        note_read_pending: 0,
      },
    ]);
  });

  it("preserves a failed ownership read and never admits the queued tool", async () => {
    const { sessions } = await owner();
    const failure = Object.freeze(new TypeError("private transport detail"));
    mockQuery.mockRejectedValue(failure);
    const execute = jest.fn();
    const guarded = sessions.guardTools({ command: { execute } } as any);
    await expect(
      guarded.command.execute!({}, { toolCallId: "tool", messages: [] } as any),
    ).rejects.toBe(failure);
    await sessions.cleanup();
    expect(execute).not.toHaveBeenCalled();
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]).toMatchObject({
      state_read_calls: 1,
      state_read_succeeded: 0,
      state_read_rejected: 1,
      state_read_pending: 0,
    });
    expect(JSON.stringify(summaries())).not.toContain(
      "private transport detail",
    );
  });

  it("keeps a detached read pending in the cleanup snapshot after Stop", async () => {
    const { sessions } = await owner();
    let settle!: (value: unknown) => void;
    mockQuery.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    const stop = new AbortController();
    const reason = new Error("Stopped by user");
    const pending = sessions.waitForAgentControl(stop.signal);
    stop.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await sessions.cleanup();
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]).toMatchObject({
      state_read_calls: 1,
      state_read_succeeded: 0,
      state_read_rejected: 0,
      state_read_pending: 1,
    });
    settle({ state: "agent", runActive: true });
    await jest.advanceTimersByTimeAsync(0);
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0].state_read_pending).toBe(1);
  });

  it("does not emit summaries for unused or unscoped browser factories", async () => {
    const { sessions } = await owner();
    await sessions.cleanup();
    const unscoped = new BrowserSessions();
    await expect(unscoped.getExitNotes()).resolves.toEqual([]);
    await unscoped.cleanup();
    expect(summaries()).toEqual([]);
  });

  it("contains logging failures so they cannot replace browser cleanup", async () => {
    const { sessions } = await owner();
    mockQuery.mockResolvedValue({ state: "agent", runActive: true });
    await expect(sessions.waitForAgentControl()).resolves.toBe(false);
    info.mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    await expect(sessions.cleanup()).resolves.toBeUndefined();
  });

  it.each([
    { runId: "private URL?token=secret", agentId: "a".repeat(129) },
    { runId: "prefix-private-service-key", agentId: "private-service-key" },
  ])(
    "bounds correlation identifiers and omits credentials and user context: %j",
    async ({ runId, agentId }) => {
      const sessions = new BrowserSessions({
        userId: "private-user",
        chatId: "private-chat",
        runId,
        agentId,
        serviceKey: "private-service-key",
      });
      await sessions.prepare({
        sandboxId: "test",
        commands: {
          run: jest.fn(async () => ({ exitCode: 0, stdout: "/usr/bin" })),
        },
      } as unknown as AnySandbox);
      mockQuery.mockResolvedValue({ state: "agent", runActive: true });
      await sessions.waitForAgentControl();
      await sessions.cleanup();
      expect(summaries()).toHaveLength(1);
      expect(summaries()[0]).toMatchObject({
        trigger_run_id: "unknown",
        agent_id: "unknown",
      });
      expect(JSON.stringify(summaries())).not.toMatch(/private|secret|a{129}/);
    },
  );
});
