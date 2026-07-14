import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetUserIDAndPro = jest.fn();
const mockGetChatById = jest.fn();
const mockSetActiveTriggerRun = jest.fn();
const mockGetTemporaryRefreshHandle = jest.fn();
const mockCloseAgentApprovalSession = jest.fn();
const mockCancelAgentTriggerRun = jest.fn();
const mockClearTemporaryRefreshCookie = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: class MockNextResponse {
    status: number;
    private body: unknown;
    cookies = { set: jest.fn(), delete: jest.fn() };

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

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: mockGetUserIDAndPro,
}));

jest.mock("@/lib/db/actions", () => ({
  getChatById: mockGetChatById,
  setActiveTriggerRun: mockSetActiveTriggerRun,
}));

jest.mock("@/lib/api/agent-approval-session", () => ({
  cancelAgentTriggerRun: mockCancelAgentTriggerRun,
  clearTemporaryAgentApprovalRefreshCookie: mockClearTemporaryRefreshCookie,
  closeAgentApprovalSession: mockCloseAgentApprovalSession,
  getTemporaryAgentApprovalRefreshHandle: mockGetTemporaryRefreshHandle,
}));

jest.mock("@/lib/api/agent-route-errors", () => ({
  handleAgentRouteError: jest.fn(() => {
    throw new Error("unexpected route error");
  }),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: mockLoggerWarn },
}));

const request = () =>
  ({
    json: jest.fn(async () => ({ chatId: "temporary-chat-1" })),
    headers: {
      get: jest.fn((name: string) =>
        name === "x-vercel-id" ? "req_agent_cancel" : null,
      ),
    },
  }) as any;

describe("agent cancel route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserIDAndPro.mockResolvedValue({ userId: "user-1" } as never);
    mockGetChatById.mockResolvedValue(null as never);
    mockGetTemporaryRefreshHandle.mockReturnValue({
      userId: "user-1",
      chatId: "temporary-chat-1",
      runId: "run-1",
      approvalSessionId: "approval-session-1",
    });
  });

  it("cancels a temporary run and clears its refresh mapping", async () => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    const req = request();
    const response = await createAgentCancelPost({ endpoint: "/api/agent" })(
      req,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      canceled: true,
      runId: "run-1",
    });
    expect(mockCloseAgentApprovalSession).toHaveBeenCalledWith(
      "approval-session-1",
      "agent-run-canceled",
    );
    expect(mockCancelAgentTriggerRun).toHaveBeenCalledWith("run-1");
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
    expect(mockClearTemporaryRefreshCookie).toHaveBeenCalledWith(response, {
      req,
      userId: "user-1",
      chatId: "temporary-chat-1",
    });
  });

  it("rejects a temporary cancellation without a valid mapping", async () => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    mockGetTemporaryRefreshHandle.mockReturnValue(null);

    const response = await createAgentCancelPost({ endpoint: "/api/agent" })(
      request(),
    );

    expect(response.status).toBe(403);
    expect(mockCancelAgentTriggerRun).not.toHaveBeenCalled();
    expect(mockClearTemporaryRefreshCookie).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Rejected Agent cancellation request",
      expect.objectContaining({
        event: "agent_cancel_rejected",
        request_id: "req_agent_cancel",
        endpoint: "/api/agent",
        route: "/api/agent/cancel",
        reason: "temporary_refresh_missing",
        status_code: 403,
        user_id: "user-1",
        chat_id: "temporary-chat-1",
      }),
    );
  });

  it("logs a distinct reason when a persisted chat belongs to another user", async () => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    mockGetChatById.mockResolvedValue({ user_id: "user-2" } as never);

    const response = await createAgentCancelPost({ endpoint: "/api/agent" })(
      request(),
    );

    expect(response.status).toBe(403);
    expect(mockGetTemporaryRefreshHandle).not.toHaveBeenCalled();
    expect(mockCancelAgentTriggerRun).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Rejected Agent cancellation request",
      expect.objectContaining({
        event: "agent_cancel_rejected",
        reason: "chat_owner_mismatch",
        status_code: 403,
        user_id: "user-1",
        chat_id: "temporary-chat-1",
      }),
    );
  });
});
