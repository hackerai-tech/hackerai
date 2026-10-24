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
const mockSuspensionQuery = jest.fn();

jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/convex/_generated/api", () => ({
  api: {
    userSuspensions: { getActiveChatAccessBlockByUser: "history-access" },
  },
}));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockSuspensionQuery }),
}));

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
    mockSuspensionQuery.mockReset();
    mockAssertUserCanAccessChatHistory.mockResolvedValue(undefined as never);
    mockCreateRedisClient.mockReturnValue(null);
    mockVerifyAgentRunCorrelationToken.mockReturnValue(true);
    mockGetChatById.mockResolvedValue(chat() as never);
    mockSaveMessage.mockResolvedValue(undefined as never);
    mockUpdateChat.mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    jest.useRealTimers();
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

  const useRealHistoryGuard = () => {
    const actual =
      jest.requireActual<typeof import("@/lib/suspensions")>(
        "@/lib/suspensions",
      );
    mockAssertUserCanAccessChatHistory.mockImplementation(
      actual.assertUserCanAccessChatHistory as never,
    );
  };

  it("saves once after a real history gate recovers from a transport failure", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    useRealHistoryGuard();
    mockSuspensionQuery
      .mockRejectedValueOnce(new TypeError("fetch failed") as never)
      .mockResolvedValueOnce(null as never);
    const controller = new AbortController();
    const req = { ...request(), signal: controller.signal };
    const response = await createAgentPartialSavePost()(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: true });
    expect(mockSuspensionQuery).toHaveBeenCalledTimes(2);
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
    expect(mockVerifyAgentRunCorrelationToken).toHaveBeenCalledTimes(1);
    expect(mockAssertUserCanAccessChatHistory).toHaveBeenCalledWith("user-1", {
      retryNetworkFailure: true,
      signal: controller.signal,
    });
  });

  it("does not parse or save when the recovered authoritative history read blocks access", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    useRealHistoryGuard();
    mockSuspensionQuery
      .mockRejectedValueOnce(new TypeError("fetch failed") as never)
      .mockResolvedValueOnce({
        category: "support_confirmed_fraud",
        source: "support",
        source_id: "PRIVATE_BLOCK_CANARY",
      } as never);
    const req = request();
    const response = await createAgentPartialSavePost()(req);
    expect(response.status).toBe(403);
    expect(mockSuspensionQuery).toHaveBeenCalledTimes(2);
    expect(req.text).not.toHaveBeenCalled();
    expect(mockGetChatById).not.toHaveBeenCalled();
    expect(mockVerifyAgentRunCorrelationToken).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockUpdateChat).not.toHaveBeenCalled();
    expect(
      JSON.stringify([...warnSpy.mock.calls, ...infoSpy.mock.calls]),
    ).not.toContain("PRIVATE_BLOCK_CANARY");
  });

  it("stops before private input and writes after the history read retry is exhausted", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    useRealHistoryGuard();
    mockSuspensionQuery.mockRejectedValue(
      new TypeError("fetch failed") as never,
    );
    const req = request();
    const response = await createAgentPartialSavePost()(req);
    expect(response.status).toBe(500);
    expect(mockSuspensionQuery).toHaveBeenCalledTimes(2);
    expect(req.text).not.toHaveBeenCalled();
    expect(mockGetChatById).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockUpdateChat).not.toHaveBeenCalled();
  });

  it("cancels history-read backoff without a second read or any write", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    useRealHistoryGuard();
    const controller = new AbortController();
    mockSuspensionQuery.mockRejectedValue(
      new TypeError("fetch failed") as never,
    );
    warnSpy.mockImplementation((message) => {
      if (String(message).includes('"event":"history_access_gate_read_retry"'))
        controller.abort();
    });
    const req = { ...request(), signal: controller.signal };
    const response = await createAgentPartialSavePost()(req);
    expect(response.status).toBe(500);
    expect(mockSuspensionQuery).toHaveBeenCalledTimes(1);
    expect(req.text).not.toHaveBeenCalled();
    expect(mockGetChatById).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockUpdateChat).not.toHaveBeenCalled();
  });

  const deferred = () => {
    let resolve!: (value?: any) => void;
    const promise = new Promise<any>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  it("bounds snapshots across the whole request and never reads private input during an early stall", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    jest.useFakeTimers();
    const history = deferred();
    const lookup = deferred();
    mockGetUserID.mockResolvedValue(diagnosticUser as never);
    mockAssertUserCanAccessChatHistory.mockReturnValue(
      history.promise as never,
    );
    mockGetChatById.mockReturnValue(lookup.promise as never);
    const req = request(diagnosticBody, { "x-vercel-id": diagnosticRequestId });
    const pending = createAgentPartialSavePost()(req);

    await jest.advanceTimersByTimeAsync(10_000);
    const first = JSON.parse(String(warnSpy.mock.calls[0][0]));
    expect(first).toMatchObject({
      event: "agent_long_client_partial_save_slow",
      stage: "history_access",
      outcome: "pending",
      elapsed_ms: 10_000,
      warning_threshold_ms: 10_000,
      timer_lateness_ms: 0,
      request_id: diagnosticRequestId,
      user_id: diagnosticUser,
      run_correlation_verified: false,
      message_save_completed: false,
    });
    expect(first.requested_chat_id).toBeUndefined();
    expect(first.trigger_run_id).toBeUndefined();
    expect(req.text).not.toHaveBeenCalled();
    history.resolve();
    await jest.advanceTimersByTimeAsync(10_000);
    const second = JSON.parse(String(warnSpy.mock.calls[1][0]));
    expect(second).toMatchObject({
      stage: "chat_lookup",
      outcome: "pending",
      elapsed_ms: 20_000,
      warning_threshold_ms: 20_000,
      timer_lateness_ms: 0,
      requested_chat_id: diagnosticBody.chatId,
      run_correlation_verified: false,
      message_save_completed: false,
    });
    expect(second.trigger_run_id).toBeUndefined();
    await jest.advanceTimersByTimeAsync(40_000);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("PRIVATE_");
    lookup.resolve(chat({ user_id: diagnosticUser }));
    expect((await pending).status).toBe(200);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("identifies both thresholds when warning callbacks are delayed", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    jest.useFakeTimers();
    const startedAt = Date.now();
    const save = deferred();
    mockGetUserID.mockResolvedValue(diagnosticUser as never);
    mockGetChatById.mockResolvedValue(
      chat({ user_id: diagnosticUser }) as never,
    );
    mockSaveMessage.mockReturnValue(save.promise as never);
    const pending = createAgentPartialSavePost()(request(diagnosticBody));
    await jest.advanceTimersByTimeAsync(0);
    const clock = jest.spyOn(Date, "now").mockReturnValue(startedAt + 20_314);
    try {
      await jest.advanceTimersByTimeAsync(20_000);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      const warnings = warnSpy.mock.calls.map(([value]) =>
        JSON.parse(String(value)),
      );
      expect(warnings).toEqual([
        expect.objectContaining({
          stage: "save_message",
          elapsed_ms: 20_314,
          warning_threshold_ms: 10_000,
          timer_lateness_ms: 10_314,
        }),
        expect.objectContaining({
          stage: "save_message",
          elapsed_ms: 20_314,
          warning_threshold_ms: 20_000,
          timer_lateness_ms: 314,
        }),
      ]);
      expect(JSON.stringify(warnings)).not.toContain("PRIVATE_");
    } finally {
      clock.mockRestore();
      save.resolve();
      expect((await pending).status).toBe(200);
    }
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("distinguishes an unacknowledged save from a stalled chat update without retrying either", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    jest.useFakeTimers();
    const save = deferred();
    const update = deferred();
    mockGetUserID.mockResolvedValue(diagnosticUser as never);
    mockGetChatById.mockResolvedValue(
      chat({ user_id: diagnosticUser }) as never,
    );
    mockSaveMessage.mockReturnValue(save.promise as never);
    mockUpdateChat.mockReturnValue(update.promise as never);
    const pending = createAgentPartialSavePost()(request(diagnosticBody));
    await jest.advanceTimersByTimeAsync(10_000);
    expect(JSON.parse(String(warnSpy.mock.calls[0][0]))).toMatchObject({
      stage: "save_message",
      outcome: "pending",
      trigger_run_id: diagnosticBody.triggerRunId,
      run_correlation_verified: true,
      message_save_completed: false,
    });
    expect(infoSpy).not.toHaveBeenCalled();
    save.resolve();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(JSON.parse(String(warnSpy.mock.calls[1][0]))).toMatchObject({
      stage: "update_chat",
      outcome: "pending",
      elapsed_ms: 20_000,
      message_save_completed: true,
    });
    await jest.advanceTimersByTimeAsync(40_000);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
    expect(mockUpdateChat).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("PRIVATE_");
    update.resolve();
    expect((await pending).status).toBe(200);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(["success", "guard", "generic_error", "database_error"])(
    "cleans up snapshots after a fast %s response",
    async (outcome) => {
      const { createAgentPartialSavePost } =
        await import("@/lib/api/agent-partial-save-route");
      jest.useFakeTimers();
      if (outcome === "guard")
        mockVerifyAgentRunCorrelationToken.mockReturnValue(false);
      if (outcome === "generic_error")
        mockSaveMessage.mockRejectedValue(
          new Error("PRIVATE_ERROR_CANARY") as never,
        );
      if (outcome === "database_error")
        mockSaveMessage.mockRejectedValue(
          new ChatSDKError("bad_request:database") as never,
        );
      const response = await createAgentPartialSavePost()(request());
      expect(response.status).toBe(
        outcome === "success"
          ? 200
          : outcome === "guard"
            ? 403
            : outcome === "database_error"
              ? 400
              : 500,
      );
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(warnSpy).not.toHaveBeenCalled();
    },
  );

  it("stops snapshots after a slow failure and omits identifiers with unknown shapes", async () => {
    const { createAgentPartialSavePost } =
      await import("@/lib/api/agent-partial-save-route");
    jest.useFakeTimers();
    let reject!: (error: Error) => void;
    mockSaveMessage.mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      }) as never,
    );
    const pending = createAgentPartialSavePost()(
      request(validBody, { "x-vercel-id": "PRIVATE_HEADER_CANARY" }),
    );
    await jest.advanceTimersByTimeAsync(10_000);
    const event = JSON.parse(String(warnSpy.mock.calls[0][0]));
    expect(event).toMatchObject({
      stage: "save_message",
      run_correlation_verified: true,
      message_save_completed: false,
    });
    for (const key of [
      "request_id",
      "user_id",
      "requested_chat_id",
      "trigger_run_id",
    ])
      expect(event[key]).toBeUndefined();
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("PRIVATE_");
    reject(new Error("PRIVATE_ERROR_CANARY"));
    expect((await pending).status).toBe(500);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

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
    expect(mockAssertUserCanAccessChatHistory).toHaveBeenCalledWith("user-1", {
      retryNetworkFailure: true,
      signal: undefined,
    });
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
