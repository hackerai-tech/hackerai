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
const mockVerifyAgentRunCorrelationToken = jest.fn();

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

jest.mock("@/lib/api/agent-run-correlation", () => ({
  verifyAgentRunCorrelationToken: mockVerifyAgentRunCorrelationToken,
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
  triggerRunId: "run-1",
  runCorrelationToken: "v1.signed-run-correlation",
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

const streamingRequest = (text: string) =>
  ({
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    text: jest.fn().mockResolvedValue(text as never),
  }) as any;

const chat = (overrides: Record<string, unknown> = {}) => ({
  id: "chat-1",
  user_id: "user-1",
  ...overrides,
});

describe("createAgentPartialSavePost", () => {
  let errorSpy: jest.SpiedFunction<typeof console.error>;
  let infoSpy: jest.SpiedFunction<typeof console.info>;
  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    installResponseShim();
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockGetUserID.mockResolvedValue("user-1" as never);
    mockAssertUserCanAccessChatHistory.mockResolvedValue(undefined as never);
    mockCreateRedisClient.mockReturnValue(null);
    mockVerifyAgentRunCorrelationToken.mockReturnValue(true);
    mockGetChatById.mockResolvedValue(chat() as never);
    mockSaveMessage.mockResolvedValue(undefined as never);
    mockUpdateChat.mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  const diagnosticUser = "user_01KPNCS7R5VE7QQSVFXMC7ENKK";
  const diagnosticBody = {
    ...validBody,
    chatId: "00000000-0000-4000-8000-000000000001",
    triggerRunId: "run_06gjlhptp1ugo15aeb9b75d4c1",
    runCorrelationToken: "PRIVATE_CORRELATION_CANARY",
    message: {
      ...validBody.message,
      parts: [{ type: "text", text: "PRIVATE_MESSAGE_CANARY" }],
    },
  };
  const diagnosticRequestId = "96gzc-1791986448417-ffa75b7dd65b";

  it("attributes an early failed read without consuming or logging the body", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    mockGetUserID.mockResolvedValue(diagnosticUser as never);
    mockAssertUserCanAccessChatHistory.mockRejectedValue(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("PRIVATE_ERROR_CANARY"), {
          code: "ECONNRESET",
        }),
      }) as never,
    );
    const req = request(diagnosticBody, {
      "x-vercel-id": diagnosticRequestId,
    });

    const response = await createAgentPartialSavePost()(req);
    const output = String(errorSpy.mock.calls[0][0]);
    const event = JSON.parse(output);

    expect(response.status).toBe(500);
    expect(req.text).not.toHaveBeenCalled();
    expect(mockGetChatById).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(event).toMatchObject({
      stage: "history_access",
      reason: "network_fetch_failed",
      transport_code: "ECONNRESET",
      request_id: diagnosticRequestId,
      user_id: diagnosticUser,
      message_save_completed: false,
      run_correlation_verified: false,
    });
    expect(event.requested_chat_id).toBeUndefined();
    expect(event.trigger_run_id).toBeUndefined();
    expect(output).not.toContain("PRIVATE_");
  });

  it("correlates a chat lookup failure without trusting the client run or exposing error data", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    mockGetChatById.mockRejectedValue(
      Object.assign(new Error("PRIVATE_ERROR_CANARY"), {
        data: { serviceKey: "PRIVATE_SERVICE_CANARY" },
      }) as never,
    );

    const response = await createAgentPartialSavePost()(
      request(diagnosticBody),
    );
    const output = String(errorSpy.mock.calls[0][0]);
    const event = JSON.parse(output);

    expect(response.status).toBe(500);
    expect(event.stage).toBe("chat_lookup");
    expect(event.requested_chat_id).toBe(diagnosticBody.chatId);
    expect(event.trigger_run_id).toBeUndefined();
    expect(event.run_correlation_verified).toBe(false);
    expect(mockVerifyAgentRunCorrelationToken).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(output).not.toContain("PRIVATE_");
  });

  it("distinguishes a post-save update failure without retrying the message write", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    mockGetChatById.mockResolvedValue(
      chat({ id: diagnosticBody.chatId }) as never,
    );
    mockUpdateChat.mockRejectedValue(
      new Error("PRIVATE_ERROR_CANARY") as never,
    );

    const response = await createAgentPartialSavePost()(
      request(diagnosticBody),
    );
    const output = String(errorSpy.mock.calls[0][0]);
    const event = JSON.parse(output);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      saved: false,
      message: "Failed to save partial response",
    });
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
    expect(event.stage).toBe("update_chat");
    expect(event.message_save_completed).toBe(true);
    expect(event.trigger_run_id).toBe(diagnosticBody.triggerRunId);
    expect(event.run_correlation_verified).toBe(true);
    expect(output).not.toContain("PRIVATE_");
  });

  it.each([
    ["chat_lookup", "bad_request:database", 400],
    ["chat_lookup", "offline:database", 503],
    ["save_message", "bad_request:database", 400],
    ["save_message", "offline:database", 503],
    ["update_chat", "bad_request:database", 400],
    ["update_chat", "offline:database", 503],
  ] as const)(
    "logs wrapped %s failures while preserving the %s response",
    async (stage, code, status) => {
      const { createAgentPartialSavePost } =
        await import("@/lib/api/agent-partial-save-route");
      const error = new ChatSDKError(code, "Database temporarily unavailable", {
        db_error_message: "PRIVATE_ERROR_CANARY",
        serviceKey: "PRIVATE_SERVICE_CANARY",
      });
      mockGetChatById.mockResolvedValue(
        chat({ id: diagnosticBody.chatId }) as never,
      );
      const failingOperation =
        stage === "chat_lookup"
          ? mockGetChatById
          : stage === "save_message"
            ? mockSaveMessage
            : mockUpdateChat;
      failingOperation.mockRejectedValue(error as never);
      const toResponse = jest.spyOn(error, "toResponse");

      const response = await createAgentPartialSavePost()(
        request(diagnosticBody),
      );
      const output = String(errorSpy.mock.calls[0][0]);
      const event = JSON.parse(output);

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        code: "",
        message: "Something went wrong. Please try again later.",
      });
      expect(toResponse).toHaveBeenCalledTimes(1);
      expect(event).toMatchObject({
        event: "agent_long_client_partial_save_failed",
        stage,
        status_code: status,
        reason: "database_error",
        error_type: "ChatSDKError",
        run_correlation_verified: stage !== "chat_lookup",
        message_save_completed: stage === "update_chat",
      });
      expect(event.trigger_run_id).toBe(
        stage === "chat_lookup" ? undefined : diagnosticBody.triggerRunId,
      );
      expect(mockSaveMessage).toHaveBeenCalledTimes(
        stage === "chat_lookup" ? 0 : 1,
      );
      expect(output).not.toContain("PRIVATE_");
    },
  );

  it.each([
    "PRIVATE_HEADER_CANARY",
    `${"a".repeat(1024)}::${diagnosticRequestId}`,
  ])(
    "omits arbitrary client identifiers and unbounded header values from failure logs",
    async (requestId) => {
      const { createAgentPartialSavePost } =
        await import("@/lib/api/agent-partial-save-route");
      mockGetChatById.mockRejectedValue(
        new Error("PRIVATE_ERROR_CANARY") as never,
      );
      const response = await createAgentPartialSavePost()(
        request(
          { ...diagnosticBody, chatId: "PRIVATE_CHAT_CANARY" },
          { "x-vercel-id": requestId },
        ),
      );
      const output = String(errorSpy.mock.calls[0][0]);
      const event = JSON.parse(output);

      expect(response.status).toBe(500);
      expect(event.request_id).toBeUndefined();
      expect(event.requested_chat_id).toBeUndefined();
      expect(event.trigger_run_id).toBeUndefined();
      expect(output).not.toContain("PRIVATE_");
      expect(output.length).toBeLessThan(1024);
    },
  );

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
        triggerRunId: "run-1",
        wasAborted: true,
      }),
    );
    expect(mockVerifyAgentRunCorrelationToken).toHaveBeenCalledWith({
      token: "v1.signed-run-correlation",
      userId: "user-1",
      chatId: "chat-1",
      runId: "run-1",
    });
    expect(mockUpdateChat).toHaveBeenCalledWith({
      chatId: "chat-1",
      finishReason: "trigger_crashed_client_saved",
      defaultModelSlug: "agent",
    });
  });

  it("does not overwrite an existing chat finish reason", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    mockGetChatById.mockResolvedValue(chat({ finish_reason: "stop" }) as never);

    const response = await createAgentPartialSavePost()(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ saved: true });
    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-1",
        userId: "user-1",
        finishReason: "trigger_crashed_client_saved",
      }),
    );
    expect(mockUpdateChat).not.toHaveBeenCalled();
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

  it("rejects an invalid Agent run correlation before writing", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    mockVerifyAgentRunCorrelationToken.mockReturnValue(false);

    const response = await createAgentPartialSavePost()(request());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({ code: "forbidden:chat" });
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockUpdateChat).not.toHaveBeenCalled();
  });

  it("rejects incomplete Agent run correlation before lookup", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    const { runCorrelationToken: _token, ...bodyWithoutToken } = validBody;

    const response = await createAgentPartialSavePost()(
      request(bodyWithoutToken),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "bad_request:api",
      cause: "Agent run correlation is incomplete.",
    });
    expect(mockGetChatById).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  it("rejects missing Agent run correlation before lookup", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    const {
      triggerRunId: _runId,
      runCorrelationToken: _token,
      ...bodyWithoutCorrelation
    } = validBody;

    const response = await createAgentPartialSavePost()(
      request(bodyWithoutCorrelation),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "bad_request:api",
      cause: "Agent run correlation is incomplete.",
    });
    expect(mockGetChatById).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
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

  it("rejects oversized streamed requests without a content-length header", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    const req = streamingRequest("x".repeat(4 * 1024 * 1024 + 1));

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
      eval: jest.fn().mockResolvedValue(0 as never),
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
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("INCR", key)'),
      ["agent_partial_save:user-1"],
      [60, 600],
    );
    expect(req.text).not.toHaveBeenCalled();
    expect(mockGetChatById).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  it("continues the partial save when Redis rate limiting is unavailable", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    const redis = {
      eval: jest.fn().mockRejectedValue(new Error("redis down") as never),
    };
    mockCreateRedisClient.mockReturnValue(redis);

    const response = await createAgentPartialSavePost()(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ saved: true });
    expect(warnSpy).toHaveBeenCalledWith(
      "[agent-partial-save] rate limit unavailable, continuing partial save:",
      expect.any(Error),
    );
    expect(mockSaveMessage).toHaveBeenCalled();
    expect(mockUpdateChat).toHaveBeenCalled();
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
