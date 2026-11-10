import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { AgentCrashRecoveryReplayLimitError } from "../agent-crash-recovery-error";

const mockGetUserIDAndPro = jest.fn();
const mockGetChatById = jest.fn();
const mockSetActiveTriggerRun = jest.fn();
const mockRunsRetrieve = jest.fn();
const mockRecover = jest.fn();
const mockCreatePublicToken = jest.fn();
const mockCloseAgentApprovalSession = jest.fn();

jest.mock("@/lib/api/agent-crash-recovery", () => ({
  recoverCrashedAgentRun: (...args: unknown[]) => mockRecover(...args),
}));

jest.mock("next/server", () => ({
  NextResponse: class MockNextResponse {
    status: number;
    private body: unknown;

    constructor(body?: unknown, init?: ResponseInit) {
      this.body = body;
      this.status = init?.status ?? 200;
    }

    static json(body: unknown, init?: ResponseInit) {
      return new MockNextResponse(body, init);
    }

    async json() {
      return this.body;
    }
  },
}));

jest.mock("@trigger.dev/sdk", () => ({
  ApiError: class MockApiError extends Error {
    status?: number;
  },
  runs: { retrieve: mockRunsRetrieve },
  auth: { createPublicToken: mockCreatePublicToken },
}));

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: mockGetUserIDAndPro,
}));

jest.mock("@/lib/db/actions", () => ({
  getChatById: mockGetChatById,
  setActiveTriggerRun: mockSetActiveTriggerRun,
}));

jest.mock("@/lib/api/agent-approval-session", () => ({
  AGENT_APPROVAL_PROTOCOL_VERSION: 2,
  AGENT_APPROVAL_TOKEN_EXPIRATION: "1m",
  closeAgentApprovalSession: mockCloseAgentApprovalSession,
}));

jest.mock("@/lib/api/agent-route-errors", () => ({
  handleAgentRouteError: jest.fn(() => {
    throw new Error("unexpected route error");
  }),
}));

jest.mock("@/lib/api/agent-run-correlation", () => ({
  createAgentRunCorrelationToken: jest.fn(() => "signed-correlation"),
}));

const requestFor = (chatId: string) =>
  ({
    headers: { get: () => null },
    nextUrl: new URL(`https://hackerai.co/api/agent/resume?chatId=${chatId}`),
  }) as any;

describe("agent resume route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetChatById.mockReset();
    mockSetActiveTriggerRun.mockReset();
    mockRunsRetrieve.mockReset();
    mockRecover.mockReset();
    mockRecover.mockResolvedValue("recovered" as never);
    mockGetUserIDAndPro.mockResolvedValue({ userId: "user-1" } as never);
  });

  it("returns a non-retryable blocked replay result without detaching or issuing another stream token", async () => {
    const { createAgentResumeGet } = await import("../agent-resume-route");
    mockGetChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: "run-1",
      active_agent_approval_session_id: "approval-1",
    } as never);
    mockRunsRetrieve.mockResolvedValue({
      status: "CRASHED",
      metadata: { chatId: "chat-1", userId: "user-1" },
    } as never);
    mockRecover.mockRejectedValueOnce(
      new AgentCrashRecoveryReplayLimitError() as never,
    );

    const response = await createAgentResumeGet({ endpoint: "/api/agent" })(
      requestFor("chat-1"),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "bad_request:api",
      metadata: { recovery: "blocked" },
    });
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
    expect(mockCloseAgentApprovalSession).not.toHaveBeenCalled();
    expect(mockCreatePublicToken).not.toHaveBeenCalled();
  });

  it.each([
    { activeRun: undefined, owner: "user-1", expectedStatus: 204 },
    { activeRun: "run-new", owner: "user-1", expectedStatus: 409 },
    { activeRun: undefined, owner: "user-other", expectedStatus: 403 },
  ])(
    "reconciles a terminal detach race without hiding a replacement run: $expectedStatus",
    async ({ activeRun, owner, expectedStatus }) => {
      const { createAgentResumeGet } = await import("../agent-resume-route");
      mockGetChatById
        .mockResolvedValueOnce({
          user_id: "user-1",
          active_trigger_run_id: "run-stopped",
        } as never)
        .mockResolvedValueOnce({
          user_id: owner,
          active_trigger_run_id: activeRun,
        } as never);
      mockRunsRetrieve.mockResolvedValueOnce({ status: "CANCELED" } as never);
      mockSetActiveTriggerRun.mockResolvedValueOnce("stale" as never);
      const response = await createAgentResumeGet({ endpoint: "/api/agent" })(
        requestFor("chat-1"),
      );
      expect(response.status).toBe(expectedStatus);
      expect(mockSetActiveTriggerRun).toHaveBeenCalledTimes(1);
      expect(mockSetActiveTriggerRun).toHaveBeenCalledWith(
        expect.objectContaining({ expectedRunId: "run-stopped" }),
      );
      expect(mockCreatePublicToken).not.toHaveBeenCalled();
    },
  );

  it("awaits crash recovery before detaching and leaves mapping intact on failure", async () => {
    const { createAgentResumeGet } = await import("../agent-resume-route");
    mockGetChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: "run-1",
    } as never);
    mockRunsRetrieve.mockResolvedValue({
      status: "CRASHED",
      metadata: { chatId: "chat-1", userId: "user-1" },
    } as never);
    let done!: (value: never) => void;
    mockRecover.mockReturnValueOnce(
      new Promise((resolve) => {
        done = resolve;
      }),
    );
    const pending = createAgentResumeGet({ endpoint: "/api/agent" })(
      requestFor("chat-1"),
    );
    for (let i = 0; i < 10 && mockRecover.mock.calls.length === 0; i++)
      await Promise.resolve();
    expect(mockRecover).toHaveBeenCalledTimes(1);
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
    done("recovered" as never);
    await pending;
    expect(mockSetActiveTriggerRun).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRunId: "run-1", recoveredCrash: true }),
    );
    mockSetActiveTriggerRun.mockClear();
    mockRecover.mockRejectedValueOnce(
      new Error("fixture recovery unavailable") as never,
    );
    await expect(
      createAgentResumeGet({ endpoint: "/api/agent" })(requestFor("chat-1")),
    ).rejects.toThrow("unexpected route error");
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
  });

  it("closes and clears an orphaned approval session when no run remains", async () => {
    const { createAgentResumeGet } = await import("../agent-resume-route");
    mockGetChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: undefined,
      active_agent_approval_session_id: "approval-session-1",
    } as never);

    const response = await createAgentResumeGet({ endpoint: "/api/agent" })(
      requestFor("chat-1"),
    );

    expect(response.status).toBe(204);
    expect(mockCloseAgentApprovalSession).toHaveBeenCalledWith(
      "approval-session-1",
      "agent-run-missing",
    );
    expect(mockSetActiveTriggerRun).toHaveBeenCalledWith({
      chatId: "chat-1",
      triggerRunId: null,
      approvalSessionId: null,
      expectedApprovalSessionId: "approval-session-1",
      clearApprovalPending: true,
    });
    expect(mockRunsRetrieve).not.toHaveBeenCalled();
    expect(mockCreatePublicToken).not.toHaveBeenCalled();
  });

  it("resumes the stored run and approval session without reselecting a permission mode", async () => {
    const { createAgentResumeGet } = await import("../agent-resume-route");
    mockGetChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: "run-auto-review-1",
      active_agent_approval_session_id: "approval-session-auto-review-1",
    } as never);
    mockRunsRetrieve.mockResolvedValue({ status: "EXECUTING" } as never);
    mockCreatePublicToken
      .mockResolvedValueOnce("run-token")
      .mockResolvedValueOnce("approval-session-token");

    const response = await createAgentResumeGet({ endpoint: "/api/agent" })(
      requestFor("chat-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runId: "run-auto-review-1",
      approvalSessionId: "approval-session-auto-review-1",
      publicAccessToken: "run-token",
      approvalSessionPublicAccessToken: "approval-session-token",
    });
    expect(mockRunsRetrieve).toHaveBeenCalledWith("run-auto-review-1");
    expect(mockCreatePublicToken).toHaveBeenNthCalledWith(1, {
      scopes: { read: { runs: ["run-auto-review-1"] } },
      expirationTime: "6h",
    });
    expect(mockCreatePublicToken).toHaveBeenNthCalledWith(2, {
      scopes: {
        write: { sessions: "approval-session-auto-review-1" },
      },
      expirationTime: "1m",
    });
  });
});
