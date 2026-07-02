import { describe, expect, it, jest } from "@jest/globals";

const loadSaveMessageWithMocks = async () => {
  jest.resetModules();
  process.env.NEXT_PUBLIC_CONVEX_URL = "https://example.convex.cloud";

  const mockMutation = jest.fn().mockResolvedValue({ id: "message-1" });
  const mockQuery = jest.fn();
  const mockPhEvent = jest.fn();
  const mockCompactMessageForStorage = jest.fn((message: any) => {
    const sizeBytes = JSON.stringify(message.parts).length;
    return {
      message,
      compacted: false,
      beforeSizeBytes: sizeBytes,
      afterSizeBytes: sizeBytes,
      strippedUiOnlyFields: false,
      prunedCount: 0,
    };
  });

  jest.doMock("server-only", () => ({}), { virtual: true });
  jest.doMock("convex/browser", () => ({
    ConvexHttpClient: class {
      mutation = mockMutation;
      query = mockQuery;
      action = jest.fn();
    },
  }));
  jest.doMock("@/lib/posthog/server", () => ({
    phLogger: {
      event: mockPhEvent,
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      flush: jest.fn(),
    },
  }));
  jest.doMock("@/lib/chat/compaction/prune-tool-outputs", () => ({
    compactMessageForStorage: mockCompactMessageForStorage,
  }));

  const {
    deleteChatForBackend,
    getChatById,
    getMessagesByChatId,
    saveChat,
    saveMessage,
  } = await import("../actions");
  return {
    deleteChatForBackend,
    getChatById,
    getMessagesByChatId,
    mockCompactMessageForStorage,
    mockMutation,
    mockPhEvent,
    mockQuery,
    saveChat,
    saveMessage,
  };
};

describe("saveChat", () => {
  it("retries generic Convex server errors before saving a new chat", async () => {
    const { saveChat, mockMutation } = await loadSaveMessageWithMocks();
    const convexError = new Error("[Request ID: abc] Server Error");
    mockMutation
      .mockRejectedValueOnce(convexError as never)
      .mockRejectedValueOnce(convexError as never)
      .mockResolvedValueOnce("chat-doc-1" as never);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(
        saveChat({
          id: "chat-1",
          userId: "user-1",
          title: "hello",
        }),
      ).resolves.toBe("chat-doc-1");

      expect(mockMutation).toHaveBeenCalledTimes(3);
      const retryEvents = warnSpy.mock.calls
        .map(([line]) => JSON.parse(String(line)))
        .filter((payload) => payload.event === "chat_save_retry_scheduled");

      expect(retryEvents).toHaveLength(2);
      expect(retryEvents[0]).toMatchObject({
        retry_reason: "convex_server_error",
        attempt: 1,
        next_attempt: 2,
        retry_delay_ms: 0,
        chat_id: "chat-1",
        user_id: "user-1",
        title_length: 5,
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("emits queryable PostHog metadata when chat creation still fails", async () => {
    const { saveChat, mockMutation, mockPhEvent } =
      await loadSaveMessageWithMocks();
    const convexError = new Error("[Request ID: abc] Server Error") as Error & {
      data?: unknown;
    };
    convexError.name = "ConvexError";
    convexError.data = {
      code: "CHAT_SAVE_FAILED",
      message: "Failed to save chat",
      failureStage: "insert_chat",
      causeName: "WorkerOverloaded",
      causeMessage: "Worker overloaded",
    };
    mockMutation.mockRejectedValue(convexError as never);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const thrown = await saveChat({
        id: "chat-1",
        userId: "user-1",
        title: "x".repeat(100),
      }).catch((error) => error);

      expect(thrown).toMatchObject({
        type: "offline",
        surface: "database",
        statusCode: 503,
        metadata: expect.objectContaining({
          db_operation: "chats.saveChat",
          db_error_name: "ConvexError",
          db_error_message: "[Request ID: abc] Server Error",
          db_request_id: "abc",
          db_error_code: "CHAT_SAVE_FAILED",
          db_failure_stage: "insert_chat",
          db_retry_reason: "worker_overloaded",
          chat_id: "chat-1",
          user_id: "user-1",
          title_length: 100,
        }),
      });

      expect(mockPhEvent).toHaveBeenCalledWith(
        "database_operation_failed",
        expect.objectContaining({
          db_operation: "chats.saveChat",
          db_request_id: "abc",
          db_error_code: "CHAT_SAVE_FAILED",
          db_failure_stage: "insert_chat",
          db_retry_reason: "worker_overloaded",
          chat_id: "chat-1",
          user_id: "user-1",
          userId: "user-1",
          title_length: 100,
        }),
      );
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe("getChatById", () => {
  it("retries transient Convex fetch failures before returning a chat", async () => {
    const { getChatById, mockQuery } = await loadSaveMessageWithMocks();
    const fetchError = new TypeError("fetch failed");
    mockQuery
      .mockRejectedValueOnce(fetchError as never)
      .mockRejectedValueOnce(fetchError as never)
      .mockResolvedValueOnce({ id: "chat-1", user_id: "user-1" } as never);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(getChatById({ id: "chat-1" })).resolves.toEqual({
        id: "chat-1",
        user_id: "user-1",
      });

      expect(mockQuery).toHaveBeenCalledTimes(3);
      const retryEvents = warnSpy.mock.calls
        .map(([line]) => JSON.parse(String(line)))
        .filter((payload) => payload.event === "chat_fetch_retry_scheduled");

      expect(retryEvents).toHaveLength(2);
      expect(retryEvents[0]).toMatchObject({
        retry_reason: "network_fetch_failed",
        attempt: 1,
        next_attempt: 2,
        retry_delay_ms: 0,
        chat_id: "chat-1",
      });
      expect(retryEvents[1]).toMatchObject({
        retry_reason: "network_fetch_failed",
        attempt: 2,
        next_attempt: 3,
        retry_delay_ms: 0,
        chat_id: "chat-1",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("classifies exhausted transient fetch failures as database availability errors", async () => {
    const { getChatById, mockPhEvent, mockQuery } =
      await loadSaveMessageWithMocks();
    mockQuery.mockRejectedValue(new TypeError("fetch failed") as never);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const thrown = await getChatById({ id: "chat-1" }).catch(
        (error) => error,
      );

      expect(thrown).toMatchObject({
        type: "offline",
        surface: "database",
        statusCode: 503,
        metadata: expect.objectContaining({
          db_operation: "chats.getChatById",
          db_error_name: "TypeError",
          db_error_message: "fetch failed",
          db_retry_reason: "network_fetch_failed",
          chat_id: "chat-1",
        }),
      });
      expect(mockQuery).toHaveBeenCalledTimes(3);
      expect(mockPhEvent).toHaveBeenCalledWith(
        "database_operation_failed",
        expect.objectContaining({
          db_operation: "chats.getChatById",
          db_error_name: "TypeError",
          db_error_message: "fetch failed",
          db_retry_reason: "network_fetch_failed",
          chat_id: "chat-1",
        }),
      );
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe("saveMessage", () => {
  it("sanitizes assistant parts before storage compaction", async () => {
    const { saveMessage, mockCompactMessageForStorage } =
      await loadSaveMessageWithMocks();
    const circularOutput: Record<string, unknown> = { ok: true };
    circularOutput.self = circularOutput;

    await expect(
      saveMessage({
        chatId: "chat-1",
        userId: "user-1",
        message: {
          id: "message-1",
          role: "assistant",
          parts: [
            {
              type: "tool-run_terminal_cmd",
              state: "output-available",
              input: { command: "echo hi" },
              output: circularOutput,
            } as any,
          ],
        },
      }),
    ).resolves.toBeDefined();

    const compactedMessage = mockCompactMessageForStorage.mock
      .calls[0]?.[0] as {
      parts: Array<{ output?: unknown }>;
    };

    expect(compactedMessage.parts[0].output).toEqual({
      ok: true,
      self: "[Circular]",
    });
    expect(() => JSON.stringify(compactedMessage.parts)).not.toThrow();
  });

  it("removes OpenRouter reasoning metadata before storage compaction", async () => {
    const { saveMessage, mockCompactMessageForStorage } =
      await loadSaveMessageWithMocks();

    await expect(
      saveMessage({
        chatId: "chat-1",
        userId: "user-1",
        message: {
          id: "message-1",
          role: "assistant",
          parts: [
            {
              type: "reasoning",
              state: "done",
              text: "private chain of thought",
              providerMetadata: {
                openrouter: {
                  reasoning_details: [
                    {
                      type: "reasoning.text",
                      text: "private chain of thought",
                    },
                  ],
                },
              },
            },
            {
              type: "tool-run_terminal_cmd",
              state: "output-available",
              toolCallId: "call-1",
              input: { command: "echo hi" },
              output: { result: { exitCode: 0, output: "hi" } },
              callProviderMetadata: {
                openrouter: {
                  reasoning_details: [
                    { type: "reasoning.text", text: "private tool thought" },
                  ],
                },
              },
              providerMetadata: {
                google: { thought_signature: "gemini-signature" },
              },
            },
          ],
        },
      }),
    ).resolves.toBeDefined();

    const compactedMessage = mockCompactMessageForStorage.mock
      .calls[0]?.[0] as {
      parts: Array<Record<string, unknown>>;
    };

    expect(compactedMessage.parts).toHaveLength(2);
    expect(compactedMessage.parts[0]).toMatchObject({
      type: "reasoning",
      state: "done",
      text: "private chain of thought",
    });
    expect(compactedMessage.parts[0].providerMetadata).toBeUndefined();
    expect(compactedMessage.parts[1].type).toBe("tool-run_terminal_cmd");
    expect(compactedMessage.parts[1].providerMetadata).toEqual({
      google: { thought_signature: "gemini-signature" },
    });
    expect(compactedMessage.parts[1].callProviderMetadata).toBeUndefined();
    expect(JSON.stringify(compactedMessage.parts)).not.toContain(
      "reasoning_details",
    );
  });

  it("sanitizes usage metadata before saving", async () => {
    const { saveMessage, mockMutation } = await loadSaveMessageWithMocks();
    const invalidUsageKey = "$provider\nraw";

    await expect(
      saveMessage({
        chatId: "chat-1",
        userId: "user-1",
        message: {
          id: "message-1",
          role: "assistant",
          parts: [{ type: "text", text: "done" }],
        },
        usage: {
          inputTokens: 12,
          [invalidUsageKey]: { ok: true },
        },
      }),
    ).resolves.toBeDefined();

    const mutationArgs = mockMutation.mock.calls[0]?.[1] as {
      usage?: Record<string, unknown>;
    };
    expect(mutationArgs.usage?.inputTokens).toBe(12);
    expect(mutationArgs.usage?.[invalidUsageKey]).toBeUndefined();

    const renamedFields = mutationArgs.usage?._convex_renamed_fields as Array<{
      storedKey: string;
      originalKey: string;
    }>;
    const renamedUsageField = renamedFields.find(
      (field) => field.originalKey === invalidUsageKey,
    );
    expect(renamedUsageField?.storedKey).toMatch(/^field_provider_raw_/);
    expect(mutationArgs.usage?.[renamedUsageField!.storedKey]).toEqual({
      ok: true,
    });
  });

  it("retries transient Convex WorkerOverloaded save failures before surfacing an error", async () => {
    const { saveMessage, mockMutation } = await loadSaveMessageWithMocks();
    const convexError = new Error("[Request ID: abc] Server Error") as Error & {
      data?: unknown;
    };
    convexError.name = "ConvexError";
    convexError.data = {
      code: "MESSAGE_SAVE_FAILED",
      message: "Failed to save message",
      failureStage: "insert_message",
      causeName: "WorkerOverloaded",
      causeMessage: "Worker overloaded",
    };
    mockMutation
      .mockRejectedValueOnce(convexError as never)
      .mockRejectedValueOnce(convexError as never)
      .mockResolvedValueOnce({ id: "message-1" } as never);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(
        saveMessage({
          chatId: "chat-1",
          userId: "user-1",
          message: {
            id: "message-1",
            role: "assistant",
            parts: [{ type: "text", text: "done" }],
          },
        }),
      ).resolves.toEqual({ id: "message-1" });

      expect(mockMutation).toHaveBeenCalledTimes(3);
      const retryEvents = warnSpy.mock.calls
        .map(([line]) => JSON.parse(String(line)))
        .filter((payload) => payload.event === "message_save_retry_scheduled");
      expect(retryEvents).toHaveLength(2);
      expect(retryEvents[0]).toMatchObject({
        retry_reason: "worker_overloaded",
        attempt: 1,
        next_attempt: 2,
        retry_delay_ms: 0,
        chat_id: "chat-1",
        message_id: "message-1",
      });
      expect(retryEvents[1]).toMatchObject({
        retry_reason: "worker_overloaded",
        attempt: 2,
        next_attempt: 3,
        retry_delay_ms: 0,
        chat_id: "chat-1",
        message_id: "message-1",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("maps Convex message-size rejections to a user-facing bad request", async () => {
    const { saveMessage, mockMutation } = await loadSaveMessageWithMocks();
    const convexError = new Error("[Request ID: abc] Server Error") as Error & {
      data?: unknown;
    };
    convexError.name = "ConvexError";
    convexError.data = {
      code: "MESSAGE_TOO_LARGE",
      message: "Message is too large to save",
      failureStage: "prepare_insert_message",
    };
    mockMutation.mockRejectedValueOnce(convexError as never);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        saveMessage({
          chatId: "chat-1",
          userId: "user-1",
          message: {
            id: "message-1",
            role: "user",
            parts: [{ type: "text", text: "x".repeat(990 * 1024) }],
          },
        }),
      ).rejects.toMatchObject({
        type: "bad_request",
        surface: "api",
        statusCode: 400,
        cause:
          "Your message is too large to save. Please shorten it or attach the content as a file instead.",
        metadata: expect.objectContaining({
          db_operation: "messages.saveMessage",
          db_error_code: "MESSAGE_TOO_LARGE",
        }),
      });

      const warnEvents = warnSpy.mock.calls.map(([line]) => {
        const payload = JSON.parse(String(line));
        return payload.event;
      });
      expect(warnEvents).toContain("message_save_rejected_too_large");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("treats wrapped canceled-chat message saves as warnings", async () => {
    const { saveMessage, mockMutation } = await loadSaveMessageWithMocks();
    const convexError = new Error("[Request ID: abc] Server Error") as Error & {
      data?: unknown;
    };
    convexError.name = "ConvexError";
    convexError.data = {
      code: "MESSAGE_SAVE_FAILED",
      message: "Failed to save message",
      failureStage: "verify_chat_writable_for_insert",
      causeData: {
        code: "CHAT_CANCELED",
        message: "This chat is no longer accepting new messages",
      },
    };
    mockMutation.mockRejectedValueOnce(convexError as never);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        saveMessage({
          chatId: "chat-1",
          userId: "user-1",
          message: {
            id: "message-1",
            role: "user",
            parts: [{ type: "text", text: "next prompt" }],
          },
        }),
      ).rejects.toMatchObject({
        type: "bad_request",
        surface: "chat",
        statusCode: 400,
        cause:
          "This chat was stopped before your message could be saved. Please send it again.",
        metadata: expect.objectContaining({
          db_operation: "messages.saveMessage",
          db_error_code: "MESSAGE_SAVE_FAILED",
          db_cause_error_code: "CHAT_CANCELED",
          db_failure_stage: "verify_chat_writable_for_insert",
        }),
      });

      const warnEvents = warnSpy.mock.calls.map(([line]) => {
        const payload = JSON.parse(String(line));
        return payload.event;
      });
      expect(warnEvents).toContain("message_save_rejected_chat_canceled");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("classifies nested message ownership denials without logging Convex error data", async () => {
    const { saveMessage, mockMutation } = await loadSaveMessageWithMocks();
    const convexError = new Error("[Request ID: abc] Server Error") as Error & {
      data?: unknown;
    };
    convexError.name = "ConvexError";
    convexError.data = {
      code: "MESSAGE_SAVE_FAILED",
      message: "Failed to save message",
      failureStage: "verify_existing_message_ownership",
      causeData: {
        code: "MESSAGE_UNAUTHORIZED",
        message: "You don't have permission to update this message",
      },
      causeMessage:
        '{"code":"MESSAGE_UNAUTHORIZED","message":"You don\'t have permission to update this message"}',
      chatId: "nested-chat-id",
      messageId: "nested-message-id",
      operation: "messages.saveMessage",
    };
    mockMutation.mockRejectedValueOnce(convexError as never);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const thrown = await saveMessage({
        chatId: "test1",
        userId: "user-1",
        message: {
          id: "1",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
        },
      }).catch((error) => error);

      expect(thrown).toMatchObject({
        type: "forbidden",
        surface: "chat",
        statusCode: 403,
        metadata: expect.objectContaining({
          db_operation: "messages.saveMessage",
          db_error_name: "ConvexError",
          db_error_message: "[Request ID: abc] Server Error",
          db_error_code: "MESSAGE_SAVE_FAILED",
          db_cause_error_code: "MESSAGE_UNAUTHORIZED",
          db_failure_stage: "verify_existing_message_ownership",
        }),
      });
      expect(thrown.metadata).not.toHaveProperty("db_error_data");

      const warnPayloads = warnSpy.mock.calls.map(([line]) =>
        JSON.parse(String(line)),
      );
      const accessDeniedPayload = warnPayloads.find(
        (payload) => payload.event === "chat_access_denied",
      );
      expect(accessDeniedPayload).toMatchObject({
        level: "warn",
        db_operation: "messages.saveMessage",
        db_error_code: "MESSAGE_SAVE_FAILED",
        db_cause_error_code: "MESSAGE_UNAUTHORIZED",
        db_failure_stage: "verify_existing_message_ownership",
        chat_id: "test1",
        user_id: "user-1",
        message_id: "1",
      });
      expect(accessDeniedPayload).not.toHaveProperty("db_error_data");
      expect(JSON.stringify(accessDeniedPayload)).not.toContain("causeData");
      expect(JSON.stringify(accessDeniedPayload)).not.toContain(
        "You don't have permission to update this message",
      );
      expect(JSON.stringify(accessDeniedPayload)).not.toContain(
        "nested-chat-id",
      );
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe("getMessagesByChatId", () => {
  it("logs empty prompts as warnings instead of errors", async () => {
    const { getMessagesByChatId } = await loadSaveMessageWithMocks();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        getMessagesByChatId({
          chatId: "chat-empty",
          userId: "user-1",
          subscription: "free",
          newMessages: [],
          regenerate: true,
          isTemporary: true,
          mode: "ask",
        }),
      ).rejects.toMatchObject({
        type: "bad_request",
        surface: "api",
        statusCode: 400,
        metadata: expect.objectContaining({
          empty_prompt: true,
          all_messages_count: 0,
          new_messages_count: 0,
        }),
      });

      const warnPayloads = warnSpy.mock.calls.map(([line]) =>
        JSON.parse(String(line)),
      );
      expect(warnPayloads).toContainEqual(
        expect.objectContaining({
          level: "warn",
          event: "chat_prompt_empty",
          chat_id: "chat-empty",
          user_id: "user-1",
          all_messages_count: 0,
          new_messages_count: 0,
        }),
      );
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("treats chat history authorization denials as warnings and forbidden chat errors", async () => {
    const { getMessagesByChatId, mockQuery } = await loadSaveMessageWithMocks();
    const convexError = new Error("[Request ID: abc] Server Error") as Error & {
      data?: unknown;
    };
    convexError.name = "ConvexError";
    convexError.data = {
      code: "CHAT_UNAUTHORIZED",
      message: "You don't have permission to access this chat",
    };

    mockQuery
      .mockResolvedValueOnce({ id: "chat-1", user_id: "user-1" })
      .mockRejectedValueOnce(convexError);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        getMessagesByChatId({
          chatId: "chat-1",
          userId: "user-1",
          subscription: "free",
          newMessages: [],
          regenerate: true,
          isTemporary: false,
          mode: "ask",
        }),
      ).rejects.toMatchObject({
        type: "forbidden",
        surface: "chat",
        statusCode: 403,
        metadata: expect.objectContaining({
          db_operation: "messages.getMessagesPageForBackend",
          db_error_code: "CHAT_UNAUTHORIZED",
        }),
      });

      const warnEvents = warnSpy.mock.calls.map(([line]) => {
        const payload = JSON.parse(String(line));
        return payload.event;
      });

      expect(warnEvents).toContain("chat_history_fetch_failed");
      expect(warnEvents).toContain("chat_access_denied");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("does not inject a stored summary while regenerating", async () => {
    const { getMessagesByChatId, mockQuery } = await loadSaveMessageWithMocks();
    const lastUserMessage = {
      id: "user-message-1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "do recon on hackerai.co" }],
    };

    mockQuery
      .mockResolvedValueOnce({
        id: "chat-1",
        user_id: "user-1",
        latest_summary_id: "summary-1",
      })
      .mockResolvedValueOnce({
        page: [lastUserMessage],
        isDone: true,
        continueCursor: "",
      });

    const result = await getMessagesByChatId({
      chatId: "chat-1",
      userId: "user-1",
      subscription: "pro",
      newMessages: [],
      regenerate: true,
      isTemporary: false,
      mode: "agent",
    });

    expect(result.truncatedMessages).toEqual([lastUserMessage]);
    expect(JSON.stringify(result.truncatedMessages)).not.toContain(
      "context_summary",
    );
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});

describe("deleteChatForBackend", () => {
  it("classifies Convex access denials as warnings and forbidden chat errors", async () => {
    const { deleteChatForBackend, mockMutation } =
      await loadSaveMessageWithMocks();
    const convexError = new Error("[Request ID: abc] Server Error") as Error & {
      data?: unknown;
    };
    convexError.name = "ConvexError";
    convexError.data = {
      code: "ACCESS_DENIED",
      message: "Unauthorized: Chat does not belong to user",
    };
    mockMutation.mockRejectedValueOnce(convexError as never);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        deleteChatForBackend({
          chatId: "chat-1",
          userId: "user-1",
        }),
      ).rejects.toMatchObject({
        type: "forbidden",
        surface: "chat",
        statusCode: 403,
        metadata: expect.objectContaining({
          db_operation: "chats.deleteChatForBackend",
          db_error_code: "ACCESS_DENIED",
        }),
      });

      const warnEvents = warnSpy.mock.calls.map(([line]) => {
        const payload = JSON.parse(String(line));
        return payload.event;
      });
      expect(warnEvents).toContain("chat_access_denied");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
