import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetUserIDAndPro = jest.fn();
const mockGetChatById = jest.fn();
const mockSetActiveTriggerRun = jest.fn();
const mockCloseAgentApprovalSession = jest.fn();
const mockCancelAgentTriggerRun = jest.fn();
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
  closeAgentApprovalSession: mockCloseAgentApprovalSession,
}));

jest.mock("@/lib/api/agent-route-errors", () => ({
  handleAgentRouteError: jest.fn(() => {
    throw new Error("unexpected route error");
  }),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: mockLoggerWarn },
}));

const request = (
  body: {
    chatId: string;
    expectedTriggerRunId?: string;
  } = { chatId: "chat-1" },
) =>
  ({
    json: jest.fn(async () => body),
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
  });

  it("rejects cancellation when the persisted chat is missing", async () => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    const response = await createAgentCancelPost({ endpoint: "/api/agent" })(
      request(),
    );

    expect(response.status).toBe(403);
    expect(mockCancelAgentTriggerRun).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Rejected Agent cancellation request",
      expect.objectContaining({
        event: "agent_cancel_rejected",
        request_id: "req_agent_cancel",
        endpoint: "/api/agent",
        route: "/api/agent/cancel",
        reason: "chat_missing",
        status_code: 403,
        user_id: "user-1",
        chat_id: "chat-1",
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
    expect(mockCancelAgentTriggerRun).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Rejected Agent cancellation request",
      expect.objectContaining({
        event: "agent_cancel_rejected",
        reason: "chat_owner_mismatch",
        status_code: 403,
        user_id: "user-1",
        chat_id: "chat-1",
      }),
    );
  });

  it("cancels the expected active run for a persisted chat", async () => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    mockGetChatById.mockResolvedValue({
      user_id: "user-1",
      active_trigger_run_id: "run-1",
      active_agent_approval_session_id: "approval-session-1",
    } as never);

    const response = await createAgentCancelPost({ endpoint: "/api/agent" })(
      request({
        chatId: "chat-1",
        expectedTriggerRunId: "run-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(mockCancelAgentTriggerRun).toHaveBeenCalledWith("run-1");
    expect(mockSetActiveTriggerRun).toHaveBeenCalledWith({
      chatId: "chat-1",
      triggerRunId: null,
      approvalSessionId: null,
      expectedRunId: "run-1",
      expectedApprovalSessionId: "approval-session-1",
      clearApprovalPending: true,
    });
  });

  it("does not let a stale cancellation stop a replacement run", async () => {
    const { createAgentCancelPost } = await import("../agent-cancel-route");
    mockGetChatById.mockResolvedValue({
      user_id: "user-1",
      active_trigger_run_id: "run-2",
    } as never);

    const response = await createAgentCancelPost({ endpoint: "/api/agent" })(
      request({
        chatId: "chat-1",
        expectedTriggerRunId: "run-1",
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      canceled: false,
      reason: "stale_run",
    });
    expect(mockCloseAgentApprovalSession).not.toHaveBeenCalled();
    expect(mockCancelAgentTriggerRun).not.toHaveBeenCalled();
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
  });
});
