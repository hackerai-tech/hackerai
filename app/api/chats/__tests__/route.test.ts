import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { ChatSDKError } from "@/lib/errors";

const mockGetUserID = jest.fn();
const mockFenceAndGetActiveAgentResourcesForUser = jest.fn();
const mockDeleteAllChatsForBackend = jest.fn();
const mockCloseAndCancelAgentResources = jest.fn();
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

jest.mock("@/lib/api/agent-deletion-cleanup", () => ({
  closeAndCancelAgentResources: mockCloseAndCancelAgentResources,
}));

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserID: mockGetUserID,
}));

jest.mock("@/lib/db/actions", () => ({
  fenceAndGetActiveAgentResourcesForUser:
    mockFenceAndGetActiveAgentResourcesForUser,
  deleteAllChatsForBackend: mockDeleteAllChatsForBackend,
}));

jest.mock("@/lib/suspensions", () => ({
  assertUserCanAccessChatHistory: mockAssertUserCanAccessChatHistory,
}));

const request = {} as any;

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

const activeResources = (...triggerRunIds: string[]) => ({
  resources: triggerRunIds.map((triggerRunId, index) => ({
    chatId: `chat-${index + 1}`,
    triggerRunId,
    approvalSessionId: `approval-session-${index + 1}`,
  })),
  hasMore: false,
});

describe("DELETE /api/chats", () => {
  let errorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    installResponseShim();
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockGetUserID.mockResolvedValue("user-1" as never);
    mockAssertUserCanAccessChatHistory.mockResolvedValue(undefined as never);
    mockFenceAndGetActiveAgentResourcesForUser.mockResolvedValue(
      activeResources("run-1", "run-2") as never,
    );
    mockCloseAndCancelAgentResources.mockResolvedValue({
      canceledTriggerRuns: 2,
      closedApprovalSessions: 2,
    } as never);
    mockDeleteAllChatsForBackend.mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("cancels active Trigger runs before deleting chats", async () => {
    const { DELETE } = await import("../route");
    const calls: string[] = [];
    mockCloseAndCancelAgentResources.mockImplementation(async () => {
      calls.push("cleanup");
      return { canceledTriggerRuns: 2, closedApprovalSessions: 2 };
    });
    mockDeleteAllChatsForBackend.mockImplementation(async () => {
      calls.push("delete");
    });

    const response = await DELETE(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      deleted: true,
      canceledTriggerRuns: 2,
      closedApprovalSessions: 2,
    });
    expect(mockFenceAndGetActiveAgentResourcesForUser).toHaveBeenCalledWith({
      userId: "user-1",
    });
    expect(mockCloseAndCancelAgentResources).toHaveBeenCalledWith(
      activeResources("run-1", "run-2").resources,
      "chat-deleted",
    );
    expect(mockDeleteAllChatsForBackend).toHaveBeenCalledWith({
      userId: "user-1",
    });
    expect(calls).toEqual(["cleanup", "delete"]);
  });

  it("passes session-only resources to cleanup before deletion", async () => {
    const { DELETE } = await import("../route");
    const resources = [
      { chatId: "chat-1", approvalSessionId: "approval-session-1" },
    ];
    mockFenceAndGetActiveAgentResourcesForUser.mockResolvedValue({
      resources,
      hasMore: false,
    } as never);
    mockCloseAndCancelAgentResources.mockResolvedValue({
      canceledTriggerRuns: 0,
      closedApprovalSessions: 1,
    } as never);

    const response = await DELETE(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      deleted: true,
      canceledTriggerRuns: 0,
      closedApprovalSessions: 1,
    });
    expect(mockCloseAndCancelAgentResources).toHaveBeenCalledWith(
      resources,
      "chat-deleted",
    );
    expect(mockDeleteAllChatsForBackend).toHaveBeenCalledWith({
      userId: "user-1",
    });
  });

  it("does not delete chats when Trigger cancellation fails", async () => {
    const { DELETE } = await import("../route");
    mockCloseAndCancelAgentResources.mockRejectedValue(
      new Error("Trigger API unavailable") as never,
    );

    const response = await DELETE(request);

    expect(response.status).toBe(500);
    expect(mockDeleteAllChatsForBackend).not.toHaveBeenCalled();
  });

  it("does not delete chats when active runs exceed the safe lookup cap", async () => {
    const { DELETE } = await import("../route");
    mockFenceAndGetActiveAgentResourcesForUser.mockResolvedValue({
      ...activeResources("run-1"),
      hasMore: true,
    } as never);

    const response = await DELETE(request);
    const text = await response.text();

    expect(response.status).toBe(409);
    expect(text).toBe("Too many active agent resources to delete safely");
    expect(mockCloseAndCancelAgentResources).not.toHaveBeenCalled();
    expect(mockDeleteAllChatsForBackend).not.toHaveBeenCalled();
  });

  it("does not delete chats while fraud-dispute chat access is suspended", async () => {
    const { DELETE } = await import("../route");
    mockAssertUserCanAccessChatHistory.mockRejectedValue(
      new ChatSDKError("forbidden:chat", "Fraud dispute hold") as never,
    );

    const response = await DELETE(request);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      code: "forbidden:chat",
      cause: "Fraud dispute hold",
    });
    expect(mockFenceAndGetActiveAgentResourcesForUser).not.toHaveBeenCalled();
    expect(mockCloseAndCancelAgentResources).not.toHaveBeenCalled();
    expect(mockDeleteAllChatsForBackend).not.toHaveBeenCalled();
  });

  it("deletes without calling Trigger when there are no active runs", async () => {
    const { DELETE } = await import("../route");
    mockFenceAndGetActiveAgentResourcesForUser.mockResolvedValue(
      activeResources() as never,
    );
    mockCloseAndCancelAgentResources.mockResolvedValue({
      canceledTriggerRuns: 0,
      closedApprovalSessions: 0,
    } as never);

    const response = await DELETE(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      deleted: true,
      canceledTriggerRuns: 0,
      closedApprovalSessions: 0,
    });
    expect(mockCloseAndCancelAgentResources).toHaveBeenCalledWith(
      [],
      "chat-deleted",
    );
    expect(mockDeleteAllChatsForBackend).toHaveBeenCalledWith({
      userId: "user-1",
    });
  });
});
