import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { ChatSDKError } from "@/lib/errors";

const mockGetUserID = jest.fn();
const mockGetActiveTriggerRunsForUser = jest.fn();
const mockDeleteAllChatsForBackend = jest.fn();
const mockRunsCancel = jest.fn();
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

jest.mock("@trigger.dev/sdk", () => ({
  runs: {
    cancel: mockRunsCancel,
  },
}));

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserID: mockGetUserID,
}));

jest.mock("@/lib/db/actions", () => ({
  getActiveTriggerRunsForUser: mockGetActiveTriggerRunsForUser,
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

const activeRuns = (...triggerRunIds: string[]) => ({
  runs: triggerRunIds.map((triggerRunId, index) => ({
    chatId: `chat-${index + 1}`,
    triggerRunId,
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
    mockGetActiveTriggerRunsForUser.mockResolvedValue(
      activeRuns("run-1", "run-2") as never,
    );
    mockRunsCancel.mockResolvedValue(undefined as never);
    mockDeleteAllChatsForBackend.mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("cancels active Trigger runs before deleting chats", async () => {
    const { DELETE } = await import("../route");
    const calls: string[] = [];
    mockRunsCancel.mockImplementation(async (triggerRunId) => {
      calls.push(`cancel:${triggerRunId}`);
    });
    mockDeleteAllChatsForBackend.mockImplementation(async () => {
      calls.push("delete");
    });

    const response = await DELETE(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ deleted: true, canceledTriggerRuns: 2 });
    expect(mockGetActiveTriggerRunsForUser).toHaveBeenCalledWith({
      userId: "user-1",
    });
    expect(mockRunsCancel).toHaveBeenNthCalledWith(1, "run-1");
    expect(mockRunsCancel).toHaveBeenNthCalledWith(2, "run-2");
    expect(mockDeleteAllChatsForBackend).toHaveBeenCalledWith({
      userId: "user-1",
    });
    expect(calls).toEqual(["cancel:run-1", "cancel:run-2", "delete"]);
  });

  it("deduplicates stored Trigger run ids before cancellation", async () => {
    const { DELETE } = await import("../route");
    mockGetActiveTriggerRunsForUser.mockResolvedValue(
      activeRuns("run-1", "run-1") as never,
    );

    const response = await DELETE(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ deleted: true, canceledTriggerRuns: 1 });
    expect(mockRunsCancel).toHaveBeenCalledTimes(1);
    expect(mockRunsCancel).toHaveBeenCalledWith("run-1");
    expect(mockDeleteAllChatsForBackend).toHaveBeenCalledWith({
      userId: "user-1",
    });
  });

  it("does not delete chats when Trigger cancellation fails", async () => {
    const { DELETE } = await import("../route");
    mockRunsCancel.mockRejectedValue(
      new Error("Trigger API unavailable") as never,
    );

    const response = await DELETE(request);

    expect(response.status).toBe(500);
    expect(mockDeleteAllChatsForBackend).not.toHaveBeenCalled();
  });

  it("does not delete chats when active runs exceed the safe lookup cap", async () => {
    const { DELETE } = await import("../route");
    mockGetActiveTriggerRunsForUser.mockResolvedValue({
      ...activeRuns("run-1"),
      hasMore: true,
    } as never);

    const response = await DELETE(request);
    const text = await response.text();

    expect(response.status).toBe(409);
    expect(text).toBe("Too many active chat runs to delete safely");
    expect(mockRunsCancel).not.toHaveBeenCalled();
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
    expect(mockGetActiveTriggerRunsForUser).not.toHaveBeenCalled();
    expect(mockRunsCancel).not.toHaveBeenCalled();
    expect(mockDeleteAllChatsForBackend).not.toHaveBeenCalled();
  });

  it("deletes without calling Trigger when there are no active runs", async () => {
    const { DELETE } = await import("../route");
    mockGetActiveTriggerRunsForUser.mockResolvedValue(activeRuns() as never);

    const response = await DELETE(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ deleted: true, canceledTriggerRuns: 0 });
    expect(mockRunsCancel).not.toHaveBeenCalled();
    expect(mockDeleteAllChatsForBackend).toHaveBeenCalledWith({
      userId: "user-1",
    });
  });
});
