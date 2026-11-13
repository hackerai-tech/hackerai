jest.mock("dockerfile-ast", () => ({}), { virtual: true });

import type { AnySandbox } from "@/types";
import { phLogger } from "@/lib/posthog/server";
import { BrowserSessions } from "../browser-sessions";

const mockQuery = jest.fn();
const mockMutation = jest.fn();
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockQuery, mutation: mockMutation }),
}));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { info: jest.fn() } }));

const connected = JSON.stringify({
  success: true,
  data: { connected: true, port: 9223 },
});

/** Register a gate-only owner without launching a browser. */
async function owner() {
  const sessions = new BrowserSessions({
    userId: "owner",
    chatId: "chat",
    runId: "run",
    agentId: "parent",
    serviceKey: "test-key",
  });
  const run = jest.fn(async () => ({ exitCode: 0, stdout: "/usr/bin" }));
  await sessions.prepare(
    {
      sandboxId: "sandbox",
      commands: { run },
    } as unknown as AnySandbox,
    "gate_only",
  );
  run.mockClear().mockResolvedValue({ exitCode: 0, stdout: connected });
  mockMutation.mockClear().mockResolvedValue(true);
  mockQuery.mockResolvedValue({
    state: "agent",
    runActive: true,
    updatedAt: 123,
    hasCompletedTakeover: false,
  });
  return { sessions, run };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockQuery.mockReset();
  mockMutation.mockReset().mockResolvedValue(true);
  jest.mocked(phLogger.info).mockClear();
});
afterEach(() => jest.useRealTimers());

it.each([
  {
    exitCode: 0,
    stdout: JSON.stringify({ success: true, data: { connected: false } }),
  },
  {
    exitCode: 0,
    stdout: JSON.stringify({
      success: true,
      data: { connected: true, port: 0 },
    }),
  },
  { exitCode: 1, stdout: "PRIVATE_OUTPUT" },
])(
  "does not park a new handoff without a usable owned browser (%j)",
  async (result) => {
    const { sessions, run } = await owner();
    run.mockResolvedValue(result);
    await expect(sessions.waitForHumanHandoff()).rejects.toThrow(/browser/i);
    expect(mockMutation).not.toHaveBeenCalled();
    expect(phLogger.info).toHaveBeenCalledWith(
      "browser_handoff_admission_diagnostics",
      expect.objectContaining({
        diagnostic_version: 4,
        admission_request_accepted: false,
        admission_observation_phase: "before_wait_request",
      }),
    );
    expect(JSON.stringify(jest.mocked(phLogger.info).mock.calls)).not.toContain(
      "PRIVATE_OUTPUT",
    );
    expect(jest.getTimerCount()).toBe(0);
  },
);

it("checks every new wait without turning the two-event log cap into a limit", async () => {
  const { sessions, run } = await owner();
  run.mockResolvedValue({ exitCode: 1, stdout: "" });
  for (let index = 0; index < 4; index++)
    await expect(sessions.waitForHumanHandoff(undefined, true)).rejects.toThrow(
      /browser/i,
    );
  expect(run).toHaveBeenCalledTimes(4);
  expect(mockMutation).not.toHaveBeenCalled();
  expect(
    jest
      .mocked(phLogger.info)
      .mock.calls.filter(
        ([event]) => event === "browser_handoff_admission_diagnostics",
      ),
  ).toHaveLength(2);
});

it("preserves a completed takeover when the browser has since closed", async () => {
  const { sessions, run } = await owner();
  mockQuery.mockResolvedValue({
    state: "agent",
    runActive: true,
    updatedAt: 123,
    hasCompletedTakeover: true,
  });
  run.mockResolvedValue({ exitCode: 1, stdout: "" });
  await expect(sessions.waitForHumanHandoff()).resolves.toBeUndefined();
  expect(mockMutation).toHaveBeenCalledTimes(1);
});

it("preserves old-backend admission until the receipt flag is deployed", async () => {
  const { sessions, run } = await owner();
  mockQuery.mockResolvedValue({
    state: "agent",
    runActive: true,
    updatedAt: 123,
  });
  run.mockResolvedValue({ exitCode: 1, stdout: "" });
  await expect(sessions.waitForHumanHandoff()).resolves.toBeUndefined();
  expect(mockMutation).toHaveBeenCalledTimes(1);
  expect(phLogger.info).toHaveBeenCalledWith(
    "browser_handoff_admission_diagnostics",
    expect.objectContaining({
      diagnostic_version: 3,
      admission_observation_phase: "after_accepted_wait_request",
    }),
  );
});

it("does not revalidate a handoff that is already waiting", async () => {
  const { sessions, run } = await owner();
  mockQuery
    .mockResolvedValueOnce({
      state: "waiting",
      runActive: true,
      updatedAt: 123,
      hasCompletedTakeover: false,
    })
    .mockResolvedValue({
      state: "agent",
      runActive: true,
      updatedAt: 456,
      hasCompletedTakeover: true,
    });
  await expect(sessions.waitForHumanHandoff()).resolves.toBeUndefined();
  expect(run).not.toHaveBeenCalled();
  expect(mockMutation).toHaveBeenCalledTimes(1);
});

it("rejects a missing browser before requesting takeover", async () => {
  const { sessions, run } = await owner();
  run.mockResolvedValue({ exitCode: 1, stdout: "" });
  await expect(sessions.waitForHumanHandoff()).rejects.toThrow(
    /Open the required page/,
  );
  expect(mockMutation).not.toHaveBeenCalled();
});

it("reports an uncertain transport as retryable inspection rather than a missing page", async () => {
  const { sessions, run } = await owner();
  run.mockRejectedValue(new Error("PRIVATE_TRANSPORT_DETAILS"));
  await expect(sessions.waitForHumanHandoff()).rejects.toThrow(
    "Browser availability could not be confirmed",
  );
  expect(mockMutation).not.toHaveBeenCalled();
  expect(JSON.stringify(jest.mocked(phLogger.info).mock.calls)).not.toContain(
    "PRIVATE_TRANSPORT_DETAILS",
  );
});

it("requires a usable browser for an explicit new takeover after completion", async () => {
  const { sessions, run } = await owner();
  mockQuery.mockResolvedValue({
    state: "agent",
    runActive: true,
    updatedAt: 123,
    hasCompletedTakeover: true,
  });
  run.mockResolvedValue({ exitCode: 1, stdout: "" });
  await expect(sessions.waitForHumanHandoff(undefined, true)).rejects.toThrow(
    /browser/i,
  );
  expect(mockMutation).not.toHaveBeenCalled();
});

it("keeps the ownership CAS authoritative when a probe races a newer state", async () => {
  const { sessions, run } = await owner();
  let version = 123;
  run.mockImplementation(async () => {
    version = 456;
    return { exitCode: 0, stdout: connected };
  });
  mockMutation.mockImplementation(
    async (_fn, args) => args.expectedUpdatedAt === version,
  );
  await expect(sessions.waitForHumanHandoff()).rejects.toThrow(
    "Browser ownership changed",
  );
  expect(mockMutation.mock.calls[0][1].expectedUpdatedAt).toBe(123);
});

it("preserves caller cancellation while availability is pending", async () => {
  const { sessions, run } = await owner();
  run.mockImplementation(() => new Promise(() => {}));
  const stop = new AbortController();
  const reason = new Error("original stop");
  const pending = sessions.waitForHumanHandoff(stop.signal);
  const rejected = expect(pending).rejects.toBe(reason);
  await jest.advanceTimersByTimeAsync(0);
  stop.abort(reason);
  await rejected;
  expect(mockMutation).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it("bounds an unavailable status response without admitting a new wait", async () => {
  const { sessions, run } = await owner();
  run.mockImplementation(() => new Promise(() => {}));
  const pending = sessions.waitForHumanHandoff();
  const rejected = expect(pending).rejects.toThrow(/browser/i);
  await jest.advanceTimersByTimeAsync(3_000);
  await rejected;
  expect(mockMutation).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it("admits a connected browser and still waits for the owner's resume", async () => {
  const { sessions, run } = await owner();
  const state = {
    state: "agent",
    runActive: true,
    updatedAt: 123,
    hasCompletedTakeover: false,
  };
  mockQuery.mockImplementation(async () => ({ ...state }));
  mockMutation.mockImplementation(async () => {
    state.state = "waiting";
    return true;
  });
  let resumed = false;
  const pending = sessions.waitForHumanHandoff().then(() => {
    resumed = true;
  });
  await jest.advanceTimersByTimeAsync(0);
  expect(resumed).toBe(false);
  // The admission check, then the waiting browser's first keepalive status.
  expect(run).toHaveBeenCalledTimes(2);
  expect(mockMutation).toHaveBeenCalledTimes(1);
  expect(phLogger.info).toHaveBeenCalledWith(
    "browser_handoff_admission_diagnostics",
    expect.objectContaining({
      diagnostic_version: 4,
      admission_request_accepted: true,
      admission_observation_phase: "before_wait_request",
    }),
  );
  state.state = "agent";
  await jest.advanceTimersByTimeAsync(1_000);
  await pending;
  expect(resumed).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});
