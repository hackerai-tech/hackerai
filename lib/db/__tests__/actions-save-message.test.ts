import { describe, expect, it, jest } from "@jest/globals";

const loadSaveMessageWithMocks = async () => {
  jest.resetModules();
  process.env.NEXT_PUBLIC_CONVEX_URL = "https://example.convex.cloud";

  const mockMutation = jest.fn().mockResolvedValue({ id: "message-1" });
  const mockQuery = jest.fn();
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
  jest.doMock("@/lib/chat/compaction/prune-tool-outputs", () => ({
    compactMessageForStorage: mockCompactMessageForStorage,
  }));

  const { getMessagesByChatId, saveMessage } = await import("../actions");
  return {
    getMessagesByChatId,
    mockCompactMessageForStorage,
    mockMutation,
    mockQuery,
    saveMessage,
  };
};

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
});

describe("getMessagesByChatId", () => {
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
