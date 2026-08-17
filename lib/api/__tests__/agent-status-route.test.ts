import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetUserIDAndPro = jest.fn();
const mockGetChatById = jest.fn();
const mockSetActiveTriggerRun = jest.fn();
const mockRunsRetrieve = jest.fn();
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
}));

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: mockGetUserIDAndPro,
}));

jest.mock("@/lib/db/actions", () => ({
  getChatById: mockGetChatById,
  setActiveTriggerRun: mockSetActiveTriggerRun,
}));

jest.mock("@/lib/api/agent-approval-session", () => ({
  closeAgentApprovalSession: mockCloseAgentApprovalSession,
}));

jest.mock("@/lib/api/agent-route-errors", () => ({
  handleAgentRouteError: jest.fn(() => {
    throw new Error("unexpected route error");
  }),
}));

const requestFor = (chatId: string, runId: string) =>
  ({
    headers: { get: () => null },
    json: async () => ({ chatId, runId }),
  }) as any;

describe("agent status route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserIDAndPro.mockResolvedValue({ userId: "user-1" } as never);
  });

  it("reports a nonterminal run without touching persisted lifecycle state", async () => {
    const { createAgentStatusPost } = await import("../agent-status-route");
    mockRunsRetrieve.mockResolvedValue({
      status: "EXECUTING",
      metadata: { chatId: "chat-1", userId: "user-1" },
    } as never);

    const response = await createAgentStatusPost({ endpoint: "/api/agent" })(
      requestFor("chat-1", "run-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "EXECUTING",
      terminal: false,
    });
    expect(mockGetChatById).not.toHaveBeenCalled();
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
  });

  it("reports terminal status and compare-clears the matching active run", async () => {
    const { createAgentStatusPost } = await import("../agent-status-route");
    mockRunsRetrieve.mockResolvedValue({
      status: "COMPLETED",
      metadata: { chatId: "chat-1", userId: "user-1" },
    } as never);
    mockGetChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: "run-1",
      active_agent_approval_session_id: "approval-session-1",
    } as never);

    const response = await createAgentStatusPost({ endpoint: "/api/agent" })(
      requestFor("chat-1", "run-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "COMPLETED",
      terminal: true,
    });
    expect(mockCloseAgentApprovalSession).toHaveBeenCalledWith(
      "approval-session-1",
      "agent-run-terminal",
    );
    expect(mockSetActiveTriggerRun).toHaveBeenCalledWith({
      chatId: "chat-1",
      triggerRunId: null,
      approvalSessionId: null,
      expectedRunId: "run-1",
      clearApprovalPending: true,
    });
  });
});
