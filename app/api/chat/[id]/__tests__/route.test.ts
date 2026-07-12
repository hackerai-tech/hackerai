import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { ChatSDKError } from "@/lib/errors";

const mockGetUserID = jest.fn();
const mockGetChatById = jest.fn();
const mockDeleteChatForBackend = jest.fn();
const mockCancelAgentTriggerRun = jest.fn();
const mockCloseAgentApprovalSession = jest.fn();
const mockAssertUserCanAccessChatHistory = jest.fn();

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

    async text() {
      return typeof this.body === "string"
        ? this.body
        : JSON.stringify(this.body ?? "");
    }
  },
}));

jest.mock("@/lib/api/agent-approval-session", () => ({
  cancelAgentTriggerRun: mockCancelAgentTriggerRun,
  closeAgentApprovalSession: mockCloseAgentApprovalSession,
}));

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserID: mockGetUserID,
}));

jest.mock("@/lib/db/actions", () => ({
  getChatById: mockGetChatById,
  deleteChatForBackend: mockDeleteChatForBackend,
}));

jest.mock("@/lib/suspensions", () => ({
  assertUserCanAccessChatHistory: mockAssertUserCanAccessChatHistory,
}));

const request = {} as any;
const paramsFor = (id = "chat-1") => ({
  params: Promise.resolve({ id }),
});

function installResponseShim() {
  (globalThis as any).Response = {
    json: (body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      json: async () => body,
      text: async () =>
        typeof body === "string" ? body : JSON.stringify(body ?? ""),
    }),
  };
}

const chat = (overrides: Record<string, unknown> = {}) => ({
  id: "chat-1",
  user_id: "user-1",
  active_trigger_run_id: "run-1",
  active_agent_approval_session_id: "approval-session-1",
  ...overrides,
});

describe("DELETE /api/chat/[id]", () => {
  let errorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    installResponseShim();
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockGetUserID.mockResolvedValue("user-1" as never);
    mockAssertUserCanAccessChatHistory.mockResolvedValue(undefined as never);
    mockGetChatById.mockResolvedValue(chat() as never);
    mockCancelAgentTriggerRun.mockResolvedValue(true as never);
    mockCloseAgentApprovalSession.mockResolvedValue(true as never);
    mockDeleteChatForBackend.mockResolvedValue("deleted" as never);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("closes the approval session and cancels its Trigger run before deleting", async () => {
    const { DELETE } = await import("../route");
    const calls: string[] = [];
    mockCancelAgentTriggerRun.mockImplementation(async () => {
      calls.push("cancel");
      return true;
    });
    mockCloseAgentApprovalSession.mockImplementation(async () => {
      calls.push("close");
      return true;
    });
    mockDeleteChatForBackend.mockImplementation(async () => {
      calls.push("delete");
    });

    const response = await DELETE(request, paramsFor());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      deleted: true,
      canceledTriggerRun: true,
      closedApprovalSession: true,
    });
    expect(mockCancelAgentTriggerRun).toHaveBeenCalledWith("run-1");
    expect(mockCloseAgentApprovalSession).toHaveBeenCalledWith(
      "approval-session-1",
      "chat-deleted",
    );
    expect(mockDeleteChatForBackend).toHaveBeenCalledWith({
      chatId: "chat-1",
      userId: "user-1",
      expectedTriggerRunId: "run-1",
      expectedApprovalSessionId: "approval-session-1",
    });
    expect(calls.slice(0, 2).sort()).toEqual(["cancel", "close"]);
    expect(calls[2]).toBe("delete");
  });

  it("does not delete when Trigger cleanup fails", async () => {
    const { DELETE } = await import("../route");
    mockCancelAgentTriggerRun.mockRejectedValue(
      new Error("Trigger API unavailable") as never,
    );

    const response = await DELETE(request, paramsFor());

    expect(response.status).toBe(500);
    expect(mockDeleteChatForBackend).not.toHaveBeenCalled();
  });

  it("deletes without calling Trigger when there is no active run", async () => {
    const { DELETE } = await import("../route");
    mockGetChatById.mockResolvedValue(
      chat({
        active_trigger_run_id: undefined,
        active_agent_approval_session_id: undefined,
      }) as never,
    );

    const response = await DELETE(request, paramsFor());

    expect(response.status).toBe(200);
    expect(mockCancelAgentTriggerRun).toHaveBeenCalledWith(undefined);
    expect(mockCloseAgentApprovalSession).toHaveBeenCalledWith(
      undefined,
      "chat-deleted",
    );
    expect(mockDeleteChatForBackend).toHaveBeenCalledWith({
      chatId: "chat-1",
      userId: "user-1",
      expectedTriggerRunId: null,
      expectedApprovalSessionId: null,
    });
  });

  it("retries cleanup when the active resource snapshot changes", async () => {
    const { DELETE } = await import("../route");
    mockGetChatById
      .mockResolvedValueOnce(chat() as never)
      .mockResolvedValueOnce(
        chat({
          active_trigger_run_id: "run-2",
          active_agent_approval_session_id: "approval-session-2",
        }) as never,
      );
    mockDeleteChatForBackend
      .mockResolvedValueOnce("stale" as never)
      .mockResolvedValueOnce("deleted" as never);

    const response = await DELETE(request, paramsFor());

    expect(response.status).toBe(200);
    expect(mockCancelAgentTriggerRun).toHaveBeenNthCalledWith(1, "run-1");
    expect(mockCancelAgentTriggerRun).toHaveBeenNthCalledWith(2, "run-2");
    expect(mockCloseAgentApprovalSession).toHaveBeenNthCalledWith(
      2,
      "approval-session-2",
      "chat-deleted",
    );
    expect(mockDeleteChatForBackend).toHaveBeenNthCalledWith(2, {
      chatId: "chat-1",
      userId: "user-1",
      expectedTriggerRunId: "run-2",
      expectedApprovalSessionId: "approval-session-2",
    });
  });

  it("does not cancel or delete chats owned by another user", async () => {
    const { DELETE } = await import("../route");
    mockGetChatById.mockResolvedValue(chat({ user_id: "other-user" }) as never);

    const response = await DELETE(request, paramsFor());

    expect(response.status).toBe(403);
    expect(mockCancelAgentTriggerRun).not.toHaveBeenCalled();
    expect(mockCloseAgentApprovalSession).not.toHaveBeenCalled();
    expect(mockDeleteChatForBackend).not.toHaveBeenCalled();
  });

  it("does not delete chats while fraud-dispute chat access is suspended", async () => {
    const { DELETE } = await import("../route");
    mockAssertUserCanAccessChatHistory.mockRejectedValue(
      new ChatSDKError("forbidden:chat", "Fraud dispute hold") as never,
    );

    const response = await DELETE(request, paramsFor());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      code: "forbidden:chat",
      cause: "Fraud dispute hold",
    });
    expect(mockGetChatById).not.toHaveBeenCalled();
    expect(mockCancelAgentTriggerRun).not.toHaveBeenCalled();
    expect(mockCloseAgentApprovalSession).not.toHaveBeenCalled();
    expect(mockDeleteChatForBackend).not.toHaveBeenCalled();
  });

  it("treats missing chats as already deleted", async () => {
    const { DELETE } = await import("../route");
    mockGetChatById.mockResolvedValue(null as never);

    const response = await DELETE(request, paramsFor());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ deleted: true, reason: "not_found" });
    expect(mockCancelAgentTriggerRun).not.toHaveBeenCalled();
    expect(mockCloseAgentApprovalSession).not.toHaveBeenCalled();
    expect(mockDeleteChatForBackend).not.toHaveBeenCalled();
  });
});
