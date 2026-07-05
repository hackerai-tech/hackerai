import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { ChatSDKError } from "@/lib/errors";

const mockGetUserID = jest.fn();
const mockGetChatById = jest.fn();
const mockSaveMessage = jest.fn();
const mockUpdateChat = jest.fn();
const mockAssertUserCanAccessChatHistory = jest.fn();
const mockCreateRedisClient = jest.fn();

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

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserID: mockGetUserID,
}));

jest.mock("@/lib/db/actions", () => ({
  getChatById: mockGetChatById,
  saveMessage: mockSaveMessage,
  updateChat: mockUpdateChat,
}));

jest.mock("@/lib/suspensions", () => ({
  assertUserCanAccessChatHistory: mockAssertUserCanAccessChatHistory,
}));

jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: mockCreateRedisClient,
}));

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

const validBody = {
  chatId: "chat-1",
  message: {
    id: "message-1",
    role: "assistant",
    parts: [{ type: "text", text: "partial assistant output" }],
  },
  generationStartedAt: 100,
  generationTimeMs: 250,
  clientReason: "resume_terminal_204",
};

const request = (
  body: unknown = validBody,
  headers: Record<string, string> = {},
) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    headers: new Headers(headers),
    text: jest.fn().mockResolvedValue(text as never),
  } as any;
};

const chat = (overrides: Record<string, unknown> = {}) => ({
  id: "chat-1",
  user_id: "user-1",
  ...overrides,
});

describe("createAgentPartialSavePost", () => {
  let errorSpy: jest.SpiedFunction<typeof console.error>;
  let infoSpy: jest.SpiedFunction<typeof console.info>;

  beforeEach(() => {
    installResponseShim();
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    mockGetUserID.mockResolvedValue("user-1" as never);
    mockAssertUserCanAccessChatHistory.mockResolvedValue(undefined as never);
    mockCreateRedisClient.mockReturnValue(null);
    mockGetChatById.mockResolvedValue(chat() as never);
    mockSaveMessage.mockResolvedValue(undefined as never);
    mockUpdateChat.mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("saves a valid assistant partial snapshot for the owning user", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");

    const response = await createAgentPartialSavePost()(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ saved: true });
    expect(mockGetUserID).toHaveBeenCalled();
    expect(mockAssertUserCanAccessChatHistory).toHaveBeenCalledWith("user-1");
    expect(mockGetChatById).toHaveBeenCalledWith({ id: "chat-1" });
    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-1",
        userId: "user-1",
        message: validBody.message,
        mode: "agent",
        generationStartedAt: 100,
        generationTimeMs: 250,
        finishReason: "trigger_crashed_client_saved",
        wasAborted: true,
      }),
    );
    expect(mockUpdateChat).toHaveBeenCalledWith({
      chatId: "chat-1",
      finishReason: "trigger_crashed_client_saved",
      defaultModelSlug: "agent",
    });
  });

  it("rejects cross-user chats before writing", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    mockGetChatById.mockResolvedValue(chat({ user_id: "user-2" }) as never);

    const response = await createAgentPartialSavePost()(request());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({ code: "forbidden:chat" });
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockUpdateChat).not.toHaveBeenCalled();
  });

  it("rejects non-assistant messages before looking up the chat", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");

    const response = await createAgentPartialSavePost()(
      request({
        ...validBody,
        message: { ...validBody.message, role: "user" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "bad_request:api",
      cause: "Only assistant messages can be partially saved.",
    });
    expect(mockGetChatById).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  it("rejects oversized requests from metadata before reading the body", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    const req = request(validBody, {
      "content-length": `${4 * 1024 * 1024 + 1}`,
    });

    const response = await createAgentPartialSavePost()(req);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "bad_request:api",
      cause: "Partial save payload is too large.",
    });
    expect(req.text).not.toHaveBeenCalled();
    expect(mockGetChatById).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  it("rate limits repeated partial-save writes before reading the body", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    const redis = {
      incr: jest.fn().mockResolvedValue(61 as never),
      expire: jest.fn(),
    };
    mockCreateRedisClient.mockReturnValue(redis);
    const req = request();

    const response = await createAgentPartialSavePost()(req);
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      code: "rate_limit:chat",
      cause:
        "Too many partial-save requests. Please wait a moment and try again.",
    });
    expect(redis.incr).toHaveBeenCalledWith("agent_partial_save:user-1");
    expect(req.text).not.toHaveBeenCalled();
    expect(mockGetChatById).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  it("returns chat access suspension errors before rate limiting", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    mockAssertUserCanAccessChatHistory.mockRejectedValue(
      new ChatSDKError("forbidden:chat", "Fraud dispute hold") as never,
    );

    const response = await createAgentPartialSavePost()(request());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      code: "forbidden:chat",
      cause: "Fraud dispute hold",
    });
    expect(mockCreateRedisClient).not.toHaveBeenCalled();
    expect(mockGetChatById).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });
});
