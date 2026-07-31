import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetUserIDAndPro = jest.fn();
const mockGetChatById = jest.fn();
const mockSetActiveTriggerRun = jest.fn();
const mockRunsRetrieve = jest.fn();
const mockCreatePublicToken = jest.fn();
const mockCloseAgentApprovalSession = jest.fn();

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
    mockGetUserIDAndPro.mockResolvedValue({ userId: "user-1" } as never);
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
});
