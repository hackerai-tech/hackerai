import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { ChatSDKError } from "@/lib/errors";

const mockGetUserID = jest.fn();
const mockGetChatById = jest.fn();
const mockDeleteChatForBackend = jest.fn();
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
    mockRunsCancel.mockResolvedValue(undefined as never);
    mockDeleteChatForBackend.mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("cancels an active Trigger run before deleting the chat", async () => {
    const { DELETE } = await import("../route");
    const calls: string[] = [];
    mockRunsCancel.mockImplementation(async () => {
      calls.push("cancel");
    });
    mockDeleteChatForBackend.mockImplementation(async () => {
      calls.push("delete");
    });

    const response = await DELETE(request, paramsFor());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ deleted: true, canceledTriggerRun: true });
    expect(mockRunsCancel).toHaveBeenCalledWith("run-1");
    expect(mockDeleteChatForBackend).toHaveBeenCalledWith({
      chatId: "chat-1",
      userId: "user-1",
    });
    expect(calls).toEqual(["cancel", "delete"]);
  });

  it("does not delete when Trigger cancellation fails", async () => {
    const { DELETE } = await import("../route");
    mockRunsCancel.mockRejectedValue(
      new Error("Trigger API unavailable") as never,
    );

    const response = await DELETE(request, paramsFor());

    expect(response.status).toBe(500);
    expect(mockDeleteChatForBackend).not.toHaveBeenCalled();
  });

  it("deletes without calling Trigger when there is no active run", async () => {
    const { DELETE } = await import("../route");
    mockGetChatById.mockResolvedValue(
      chat({ active_trigger_run_id: undefined }) as never,
    );

    const response = await DELETE(request, paramsFor());

    expect(response.status).toBe(200);
    expect(mockRunsCancel).not.toHaveBeenCalled();
    expect(mockDeleteChatForBackend).toHaveBeenCalledWith({
      chatId: "chat-1",
      userId: "user-1",
    });
  });

  it("does not cancel or delete chats owned by another user", async () => {
    const { DELETE } = await import("../route");
    mockGetChatById.mockResolvedValue(chat({ user_id: "other-user" }) as never);

    const response = await DELETE(request, paramsFor());

    expect(response.status).toBe(403);
    expect(mockRunsCancel).not.toHaveBeenCalled();
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
    expect(mockRunsCancel).not.toHaveBeenCalled();
    expect(mockDeleteChatForBackend).not.toHaveBeenCalled();
  });

  it("treats missing chats as already deleted", async () => {
    const { DELETE } = await import("../route");
    mockGetChatById.mockResolvedValue(null as never);

    const response = await DELETE(request, paramsFor());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ deleted: true, reason: "not_found" });
    expect(mockRunsCancel).not.toHaveBeenCalled();
    expect(mockDeleteChatForBackend).not.toHaveBeenCalled();
  });
});
