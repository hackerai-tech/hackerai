import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockRunsCancel = jest.fn();
const mockSessionsClose = jest.fn();

class MockApiError extends Error {
  status?: number;

  constructor(status?: number) {
    super(`Trigger API error ${status ?? "unknown"}`);
    this.status = status;
  }
}

jest.mock("@trigger.dev/sdk", () => ({
  ApiError: MockApiError,
  runs: { cancel: mockRunsCancel },
  sessions: { close: mockSessionsClose },
}));

describe("agent approval session lifecycle", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.AGENT_APPROVAL_TOKEN_EXPIRATION;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it("uses a 15m production default and accepts a 1m E2E override", async () => {
    const defaultSessionModule = await import("../agent-approval-session");
    expect(defaultSessionModule.AGENT_APPROVAL_TOKEN_EXPIRATION).toBe("15m");

    jest.resetModules();
    process.env.AGENT_APPROVAL_TOKEN_EXPIRATION = "1m";
    const overrideSessionModule = await import("../agent-approval-session");
    expect(overrideSessionModule.AGENT_APPROVAL_TOKEN_EXPIRATION).toBe("1m");
  });

  it("treats already-terminal cleanup as success but rethrows outages", async () => {
    const { cancelAgentTriggerRun, closeAgentApprovalSession } =
      await import("../agent-approval-session");

    mockRunsCancel.mockRejectedValueOnce(new MockApiError(404));
    mockSessionsClose.mockRejectedValueOnce(new MockApiError(409));
    await expect(cancelAgentTriggerRun("run-terminal")).resolves.toBe(true);
    await expect(
      closeAgentApprovalSession("session-terminal", "terminal"),
    ).resolves.toBe(true);

    mockRunsCancel.mockRejectedValueOnce(new MockApiError(503));
    mockSessionsClose.mockRejectedValueOnce(new MockApiError(503));
    await expect(cancelAgentTriggerRun("run-outage")).rejects.toThrow();
    await expect(
      closeAgentApprovalSession("session-outage", "outage"),
    ).rejects.toThrow();
  });
});
