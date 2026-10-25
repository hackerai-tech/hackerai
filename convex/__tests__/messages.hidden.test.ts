import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Id } from "../_generated/dataModel";

jest.mock("../lib/serviceFunctions", () => ({
  mutation: jest.fn((config: any) => config),
  internalMutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
  internalQuery: jest.fn((config: any) => config),
}));
jest.mock("convex/values", () => {
  const actualValues =
    jest.requireActual<typeof import("convex/values")>("convex/values");

  return {
    v: {
      id: jest.fn(() => "id"),
      null: jest.fn(() => "null"),
      string: jest.fn(() => "string"),
      number: jest.fn(() => "number"),
      optional: jest.fn(() => "optional"),
      object: jest.fn(() => "object"),
      union: jest.fn(() => "union"),
      array: jest.fn(() => "array"),
      boolean: jest.fn(() => "boolean"),
      literal: jest.fn(() => "literal"),
      any: jest.fn(() => "any"),
    },
    ConvexError: class ConvexError extends Error {
      data: any;
      constructor(data: any) {
        super(typeof data === "string" ? data : data.message);
        this.data = data;
        this.name = "ConvexError";
      }
    },
    getDocumentSize: actualValues.getDocumentSize,
    getConvexSize: actualValues.getConvexSize,
  };
});
jest.mock("../_generated/api", () => ({
  internal: {
    messages: {
      verifyChatOwnership: "internal.messages.verifyChatOwnership",
    },
    s3Cleanup: {
      deleteS3ObjectAction: "internal.s3Cleanup.deleteS3ObjectAction",
    },
  },
}));
jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));
jest.mock("../lib/suspensionGuards", () => ({
  assertUserCanAccessChatHistory: jest.fn<any>().mockResolvedValue(undefined),
  isUserBlockedFromChatHistory: jest.fn<any>().mockResolvedValue(false),
  CHAT_ACCESS_SUSPENDED_CODE: "CHAT_ACCESS_SUSPENDED",
}));
jest.mock("../fileAggregate", () => ({
  fileCountAggregate: {
    deleteIfExists: jest.fn<any>().mockResolvedValue(undefined),
  },
}));
jest.mock("convex/server", () => ({
  paginationOptsValidator: "paginationOptsValidator",
}));

const SERVICE_KEY = "test-service-key";
process.env.CONVEX_SERVICE_ROLE_KEY = SERVICE_KEY;

const CHAT_ID = "chat-001";
const USER_ID = "user-123";

function makeMessage(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    _id: "msg-doc-1" as Id<"messages">,
    id: "msg-1",
    chat_id: CHAT_ID,
    user_id: USER_ID,
    role: "user",
    parts: [{ type: "text", text: "hello" }],
    _creationTime: 1000,
    file_ids: undefined,
    feedback_id: undefined,
    is_hidden: undefined,
    ...overrides,
  };
}

describe("saveMessage — is_hidden handling", () => {
  let mockCtx: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});

    mockCtx = {
      db: {
        query: jest.fn(),
        get: jest.fn<any>().mockResolvedValue(null),
        normalizeId: jest.fn((_table: string, id: string) => id),
        insert: jest
          .fn<any>()
          .mockResolvedValue("new-msg-id" as Id<"messages">),
        patch: jest.fn<any>().mockResolvedValue(undefined),
        delete: jest.fn<any>().mockResolvedValue(undefined),
      },
      runQuery: jest.fn<any>().mockResolvedValue(true),
    };
  });

  function setupExistingMessage(
    msg: Record<string, any> | null,
    chat: Record<string, any> | null = {
      _id: "chat-doc-1",
      id: CHAT_ID,
      user_id: USER_ID,
      canceled_at: undefined,
    },
  ): void {
    mockCtx.db.query.mockImplementation((table: string) => {
      if (table === "messages") {
        return {
          withIndex: jest.fn().mockReturnValue({
            first: jest.fn<any>().mockResolvedValue(msg),
          }),
        };
      }

      if (table === "chats") {
        return {
          withIndex: jest.fn().mockReturnValue({
            first: jest.fn<any>().mockResolvedValue(chat),
          }),
        };
      }

      return {
        withIndex: jest.fn().mockReturnValue({
          first: jest.fn<any>().mockResolvedValue(null),
        }),
      };
    });
  }

  it.each(["run-new", undefined])(
    "rejects a crash save when active run is %s",
    async (activeRun) => {
      setupExistingMessage(null, {
        _id: "chat-doc",
        id: CHAT_ID,
        user_id: USER_ID,
        active_trigger_run_id: activeRun,
      });
      const { saveMessage } = await import("../messages");
      expect(
        await saveMessage.handler(mockCtx, {
          serviceKey: SERVICE_KEY,
          id: "message",
          chatId: CHAT_ID,
          userId: USER_ID,
          role: "assistant",
          parts: [{ type: "text", text: "stale" }],
          triggerRunId: "run-old",
          expectedActiveTriggerRunId: "run-old",
        }),
      ).toBe("stale_run");
      expect(mockCtx.db.insert).not.toHaveBeenCalled();
      expect(mockCtx.db.patch).not.toHaveBeenCalled();
    },
  );

  it.each(["trigger_crashed_client_saved", "stop"])(
    "refreshes only the same run's recoverable snapshot, existing reason %s",
    async (finishReason) => {
      const message = makeMessage({
        role: "assistant",
        finish_reason: finishReason,
        trigger_run_id: "run-old",
      });
      setupExistingMessage(message, {
        _id: "chat-doc",
        id: CHAT_ID,
        user_id: USER_ID,
        active_trigger_run_id: "run-old",
      });
      const { saveMessage } = await import("../messages");
      await saveMessage.handler(mockCtx, {
        serviceKey: SERVICE_KEY,
        id: message.id,
        chatId: CHAT_ID,
        userId: USER_ID,
        role: "assistant",
        parts: [{ type: "text", text: "full retained progress" }],
        triggerRunId: "run-old",
        expectedActiveTriggerRunId: "run-old",
      });
      if (finishReason === "stop")
        expect(mockCtx.db.patch).not.toHaveBeenCalled();
      else
        expect(mockCtx.db.patch).toHaveBeenCalledWith(
          message._id,
          expect.objectContaining({
            parts: [{ type: "text", text: "full retained progress" }],
          }),
        );
      expect(mockCtx.db.insert).not.toHaveBeenCalled();
    },
  );

  it.each([
    { canceled_at: 1 },
    { deletion_started_at: 1 },
    { user_id: "different" },
  ])("does not recover into an unwritable chat %j", async (fields) => {
    setupExistingMessage(null, {
      _id: "chat-doc",
      id: CHAT_ID,
      user_id: USER_ID,
      active_trigger_run_id: "run-old",
      ...fields,
    });
    const { saveMessage } = await import("../messages");
    expect(
      await saveMessage.handler(mockCtx, {
        serviceKey: SERVICE_KEY,
        id: "message",
        chatId: CHAT_ID,
        userId: USER_ID,
        role: "assistant",
        parts: [],
        triggerRunId: "run-old",
        expectedActiveTriggerRunId: "run-old",
      }),
    ).toBe("stale_run");
    expect(mockCtx.db.insert).not.toHaveBeenCalled();
    expect(mockCtx.db.patch).not.toHaveBeenCalled();
  });

  it("should store is_hidden: true on insert", async () => {
    setupExistingMessage(null);

    const { saveMessage } = await import("../messages");

    await saveMessage.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      id: "msg-new",
      chatId: CHAT_ID,
      userId: USER_ID,
      role: "user" as const,
      parts: [{ type: "text", text: "hidden message" }],
      isHidden: true,
    });

    expect(mockCtx.db.insert).toHaveBeenCalledWith(
      "messages",
      expect.objectContaining({ is_hidden: true }),
    );
    expect(mockCtx.db.patch).not.toHaveBeenCalledWith(
      "chat-doc-1",
      expect.objectContaining({ update_time: expect.any(Number) }),
    );
  });

  it("bumps chat activity when a visible user message is inserted", async () => {
    setupExistingMessage(null);

    const { saveMessage } = await import("../messages");

    await saveMessage.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      id: "msg-visible-user",
      chatId: CHAT_ID,
      userId: USER_ID,
      role: "user" as const,
      parts: [{ type: "text", text: "move this chat to the top" }],
    });

    const insertedMessage = mockCtx.db.insert.mock.calls[0]?.[1];
    expect(mockCtx.db.patch).toHaveBeenCalledWith("chat-doc-1", {
      update_time: insertedMessage.update_time,
    });
  });

  it("does not bump chat activity for assistant message inserts", async () => {
    setupExistingMessage(null);

    const { saveMessage } = await import("../messages");

    await saveMessage.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      id: "msg-visible-assistant",
      chatId: CHAT_ID,
      userId: USER_ID,
      role: "assistant" as const,
      parts: [{ type: "text", text: "response" }],
    });

    expect(mockCtx.db.patch).not.toHaveBeenCalledWith(
      "chat-doc-1",
      expect.objectContaining({ update_time: expect.any(Number) }),
    );
  });

  it("records only a completed server-verified Abliteration seed on the owned chat", async () => {
    const priorSeedAt = Date.now() - 16 * 60 * 60 * 1000;
    setupExistingMessage(null, {
      _id: "chat-doc-1",
      id: CHAT_ID,
      user_id: USER_ID,
      abliteration_seed_count: 1,
      abliteration_last_seed_at: priorSeedAt,
    });
    const { saveMessage } = await import("../messages");
    await saveMessage.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      id: "completed-abliteration",
      chatId: CHAT_ID,
      userId: USER_ID,
      role: "assistant",
      parts: [{ type: "text", text: "bounded response" }],
      finishReason: "stop",
      usage: {
        abliterationRouting: {
          version: 1,
          source: "moderation",
          completed: true,
        },
      },
    });
    expect(mockCtx.db.patch).toHaveBeenCalledWith(
      "chat-doc-1",
      expect.objectContaining({
        abliteration_seed_count: 2,
        abliteration_previous_seed_at: priorSeedAt,
        abliteration_last_seed_at: expect.any(Number),
      }),
    );
  });

  it("keeps a qualifying seed when the same chat resumes after 30 days", async () => {
    const now = Date.UTC(2026, 9, 16, 12);
    const previousSeedAt = now - 30 * 24 * 60 * 60 * 1000;
    const clock = jest.spyOn(Date, "now").mockReturnValue(now);
    try {
      setupExistingMessage(null, {
        _id: "chat-doc-1",
        id: CHAT_ID,
        user_id: USER_ID,
        abliteration_seed_count: 1,
        abliteration_last_seed_at: previousSeedAt,
      });
      const { saveMessage } = await import("../messages");
      await saveMessage.handler(mockCtx, {
        serviceKey: SERVICE_KEY,
        id: "completed-after-pause",
        chatId: CHAT_ID,
        userId: USER_ID,
        role: "assistant",
        parts: [{ type: "text", text: "bounded response" }],
        finishReason: "stop",
        usage: {
          abliterationRouting: {
            version: 1,
            source: "moderation",
            completed: true,
          },
        },
      });
      expect(mockCtx.db.patch).toHaveBeenCalledWith(
        "chat-doc-1",
        expect.objectContaining({
          abliteration_seed_count: 2,
          abliteration_previous_seed_at: previousSeedAt,
          abliteration_last_seed_at: now,
        }),
      );
    } finally {
      clock.mockRestore();
    }
  });

  it("caps established same-chat evidence at two after a pause", async () => {
    setupExistingMessage(null, {
      _id: "chat-doc-1",
      id: CHAT_ID,
      user_id: USER_ID,
      abliteration_seed_count: 2,
      abliteration_last_seed_at: Date.now() - 25 * 60 * 60 * 1000,
    });
    const { saveMessage } = await import("../messages");
    await saveMessage.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      id: "completed-after-gap",
      chatId: CHAT_ID,
      userId: USER_ID,
      role: "assistant",
      parts: [{ type: "text", text: "bounded response" }],
      finishReason: "stop",
      usage: {
        abliterationRouting: {
          version: 1,
          source: "moderation",
          completed: true,
        },
      },
    });
    expect(mockCtx.db.patch).toHaveBeenCalledWith(
      "chat-doc-1",
      expect.objectContaining({
        abliteration_seed_count: 2,
      }),
    );
  });

  it("records a seed when a streaming assistant message is completed by a later patch", async () => {
    setupExistingMessage(
      makeMessage({ id: "streaming-response", role: "assistant" }),
      {
        _id: "chat-doc-1",
        id: CHAT_ID,
        user_id: USER_ID,
      },
    );
    const { saveMessage } = await import("../messages");
    await saveMessage.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      id: "streaming-response",
      chatId: CHAT_ID,
      userId: USER_ID,
      role: "assistant",
      parts: [{ type: "text", text: "completed response" }],
      finishReason: "stop",
      usage: {
        abliterationRouting: {
          version: 1,
          source: "moderation",
          completed: true,
        },
      },
    });
    expect(mockCtx.db.patch).toHaveBeenCalledWith(
      "chat-doc-1",
      expect.objectContaining({ abliteration_seed_count: 1 }),
    );
  });

  it.each([
    ["user", "stop", "stop", false],
    ["assistant", "aborted", "stop", false],
    ["assistant", "stop", "aborted", true],
    ["assistant", "", "stop", true],
  ] as const)(
    "bases seed eligibility on persisted %s/%s when the update requests %s",
    async (role, storedFinishReason, requestedFinishReason, shouldSeed) => {
      const existing = makeMessage({
        id: "updated-response",
        role,
        finish_reason: storedFinishReason,
      });
      setupExistingMessage(existing);
      const { saveMessage } = await import("../messages");
      await saveMessage.handler(mockCtx, {
        serviceKey: SERVICE_KEY,
        id: "updated-response",
        chatId: CHAT_ID,
        userId: USER_ID,
        role: "assistant",
        parts: [{ type: "text", text: "completed response" }],
        finishReason: requestedFinishReason,
        usage: {
          abliterationRouting: {
            version: 1,
            source: "moderation",
            completed: true,
          },
        },
      });
      const messagePatch = mockCtx.db.patch.mock.calls.find(
        ([id]: [string]) => id === existing._id,
      )?.[1];
      expect({ ...existing, ...messagePatch }).toMatchObject({
        role,
        finish_reason: storedFinishReason || requestedFinishReason,
      });
      const seedPatch = mockCtx.db.patch.mock.calls.find(
        ([id, patch]: [string, Record<string, unknown>]) =>
          id === "chat-doc-1" && "abliteration_seed_count" in patch,
      )?.[1];
      if (shouldSeed) {
        expect(seedPatch).toMatchObject({ abliteration_seed_count: 1 });
      } else {
        expect(seedPatch).toBeUndefined();
      }
    },
  );

  it("never seeds from hidden, incomplete, inherited, or already recorded responses", async () => {
    const { saveMessage } = await import("../messages");
    for (const [id, finishReason, source, isHidden] of [
      ["hidden", "stop", "moderation", true],
      ["aborted", "aborted", "moderation", false],
      ["inherited", "stop", "history", false],
    ] as const) {
      setupExistingMessage(null);
      mockCtx.db.patch.mockClear();
      await saveMessage.handler(mockCtx, {
        serviceKey: SERVICE_KEY,
        id,
        chatId: CHAT_ID,
        userId: USER_ID,
        role: "assistant",
        parts: [{ type: "text", text: "response" }],
        finishReason,
        isHidden,
        usage: {
          abliterationRouting: { version: 1, source, completed: true },
        },
      });
      expect(mockCtx.db.patch).not.toHaveBeenCalledWith(
        "chat-doc-1",
        expect.objectContaining({
          abliteration_seed_count: expect.any(Number),
        }),
      );
    }
    setupExistingMessage(
      makeMessage({
        role: "assistant",
        finish_reason: "stop",
        usage: {
          abliterationRouting: {
            version: 1,
            source: "moderation",
            completed: true,
          },
        },
      }),
    );
    mockCtx.db.patch.mockClear();
    await saveMessage.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      id: "msg-1",
      chatId: CHAT_ID,
      userId: USER_ID,
      role: "assistant",
      parts: [{ type: "text", text: "response" }],
      finishReason: "stop",
      usage: {
        abliterationRouting: {
          version: 1,
          source: "moderation",
          completed: true,
        },
      },
    });
    expect(mockCtx.db.patch).not.toHaveBeenCalledWith(
      "chat-doc-1",
      expect.objectContaining({ abliteration_seed_count: expect.any(Number) }),
    );
  });

  it("does not bump chat activity when an existing user message is retried", async () => {
    setupExistingMessage(makeMessage());

    const { saveMessage } = await import("../messages");

    await saveMessage.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      id: "msg-1",
      chatId: CHAT_ID,
      userId: USER_ID,
      role: "user" as const,
      parts: [{ type: "text", text: "hello" }],
    });

    expect(mockCtx.db.patch).not.toHaveBeenCalledWith(
      "chat-doc-1",
      expect.objectContaining({ update_time: expect.any(Number) }),
    );
  });

  it("stores the Trigger run ID on an inserted assistant message", async () => {
    setupExistingMessage(null);

    const { saveMessage } = await import("../messages");

    await saveMessage.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      id: "msg-agent",
      chatId: CHAT_ID,
      userId: USER_ID,
      role: "assistant" as const,
      parts: [{ type: "text", text: "partial output" }],
      finishReason: "trigger_crashed_client_saved",
      triggerRunId: "run-1",
    });

    expect(mockCtx.db.insert).toHaveBeenCalledWith(
      "messages",
      expect.objectContaining({
        finish_reason: "trigger_crashed_client_saved",
        trigger_run_id: "run-1",
      }),
    );
  });

  it("rejects changing an existing message to a different Trigger run", async () => {
    const existing = makeMessage({
      role: "assistant",
      trigger_run_id: "run-1",
    });
    setupExistingMessage(existing);

    const { saveMessage } = await import("../messages");

    await expect(
      saveMessage.handler(mockCtx, {
        serviceKey: SERVICE_KEY,
        id: "msg-1",
        chatId: CHAT_ID,
        userId: USER_ID,
        role: "assistant" as const,
        parts: [{ type: "text", text: "partial output" }],
        triggerRunId: "run-2",
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({
        code: "MESSAGE_SAVE_FAILED",
        failureStage: "verify_existing_message_trigger_run",
      }),
    });
    expect(mockCtx.db.patch).not.toHaveBeenCalled();
  });

  it("should store is_hidden on update when isHidden is provided", async () => {
    const existing = makeMessage({ _id: "existing-doc" as Id<"messages"> });
    setupExistingMessage(existing);

    const { saveMessage } = await import("../messages");

    await saveMessage.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      id: "msg-1",
      chatId: CHAT_ID,
      userId: USER_ID,
      role: "user" as const,
      parts: [{ type: "text", text: "hello" }],
      isHidden: true,
    });

    expect(mockCtx.db.patch).toHaveBeenCalledWith(
      "existing-doc",
      expect.objectContaining({ is_hidden: true }),
    );
  });

  it("rejects hiding an existing message owned by another chat or user", async () => {
    const existing = makeMessage({
      _id: "victim-doc" as Id<"messages">,
      id: "victim-message-id",
      chat_id: "victim-chat",
      user_id: "victim-user",
      is_hidden: false,
    });
    setupExistingMessage(existing);

    const { saveMessage } = await import("../messages");

    await expect(
      saveMessage.handler(mockCtx, {
        serviceKey: SERVICE_KEY,
        id: "victim-message-id",
        chatId: CHAT_ID,
        userId: USER_ID,
        role: "user" as const,
        parts: [{ type: "text", text: "continue" }],
        isHidden: true,
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({
        code: "MESSAGE_SAVE_FAILED",
        failureStage: "verify_existing_message_ownership",
        causeData: expect.objectContaining({
          code: "MESSAGE_UNAUTHORIZED",
        }),
      }),
    });

    expect(mockCtx.db.patch).not.toHaveBeenCalled();
    expect(mockCtx.runQuery).not.toHaveBeenCalled();
  });

  it("should not include is_hidden: true on insert when isHidden is not provided", async () => {
    setupExistingMessage(null);

    const { saveMessage } = await import("../messages");

    await saveMessage.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      id: "msg-no-hidden",
      chatId: CHAT_ID,
      userId: USER_ID,
      role: "user" as const,
      parts: [{ type: "text", text: "visible message" }],
    });

    expect(mockCtx.db.insert).toHaveBeenCalledWith(
      "messages",
      expect.objectContaining({ is_hidden: undefined }),
    );
    expect(mockCtx.db.insert).not.toHaveBeenCalledWith(
      "messages",
      expect.objectContaining({ is_hidden: true }),
    );
  });

  it("truncates oversized search content while preserving the canonical parts", async () => {
    setupExistingMessage(null);
    const largeText = "x".repeat(557_726);

    const { saveMessage } = await import("../messages");

    await saveMessage.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      id: "msg-large-search-content",
      chatId: CHAT_ID,
      userId: USER_ID,
      role: "user" as const,
      parts: [{ type: "text", text: largeText }],
    });

    const inserted = mockCtx.db.insert.mock.calls[0][1];
    expect(inserted.parts).toEqual([{ type: "text", text: largeText }]);
    expect(inserted.content.length).toBeGreaterThan(256);
    expect(inserted.content.length).toBeLessThan(largeText.length);
    expect(JSON.stringify(inserted).length).toBeLessThanOrEqual(960 * 1024);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("message_search_content_truncated_for_storage"),
    );
  });

  it("rejects messages that are too large even without indexed content", async () => {
    setupExistingMessage(null);
    const tooLargeText = "x".repeat(990 * 1024);

    const { saveMessage } = await import("../messages");

    await expect(
      saveMessage.handler(mockCtx, {
        serviceKey: SERVICE_KEY,
        id: "msg-too-large",
        chatId: CHAT_ID,
        userId: USER_ID,
        role: "user" as const,
        parts: [{ type: "text", text: tooLargeText }],
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({
        code: "MESSAGE_TOO_LARGE",
        failureStage: "prepare_insert_message",
      }),
    });

    expect(mockCtx.db.insert).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("convex_message_save_rejected_too_large"),
    );
  });

  it("skips assistant inserts when the chat was deleted before save", async () => {
    setupExistingMessage(null, null);

    const { saveMessage } = await import("../messages");

    await expect(
      saveMessage.handler(mockCtx, {
        serviceKey: SERVICE_KEY,
        id: "msg-assistant",
        chatId: CHAT_ID,
        userId: USER_ID,
        role: "assistant" as const,
        parts: [{ type: "text", text: "done" }],
        finishReason: "preemptive-timeout",
      }),
    ).resolves.toBeNull();

    expect(mockCtx.db.insert).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("convex_message_save_skipped_chat_not_found"),
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it("skips assistant inserts when the chat is already canceled", async () => {
    setupExistingMessage(null, {
      _id: "chat-doc-1",
      id: CHAT_ID,
      user_id: USER_ID,
      canceled_at: Date.now(),
    });

    const { saveMessage } = await import("../messages");

    await expect(
      saveMessage.handler(mockCtx, {
        serviceKey: SERVICE_KEY,
        id: "msg-assistant-canceled",
        chatId: CHAT_ID,
        userId: USER_ID,
        role: "assistant" as const,
        parts: [{ type: "text", text: "late result" }],
      }),
    ).resolves.toBeNull();

    expect(mockCtx.db.insert).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("convex_message_save_skipped_chat_canceled"),
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it("clears stale cancellation state for new user inserts", async () => {
    setupExistingMessage(null, {
      _id: "chat-doc-1",
      id: CHAT_ID,
      user_id: USER_ID,
      active_stream_id: "old-stream",
      canceled_at: Date.now(),
    });

    const { saveMessage } = await import("../messages");

    await expect(
      saveMessage.handler(mockCtx, {
        serviceKey: SERVICE_KEY,
        id: "msg-user-canceled",
        chatId: CHAT_ID,
        userId: USER_ID,
        role: "user" as const,
        parts: [{ type: "text", text: "late user message" }],
      }),
    ).resolves.toBeNull();

    expect(mockCtx.db.patch).toHaveBeenCalledWith("chat-doc-1", {
      canceled_at: undefined,
    });
    expect(mockCtx.db.patch).toHaveBeenCalledWith("chat-doc-1", {
      update_time: expect.any(Number),
    });
    expect(mockCtx.db.insert).toHaveBeenCalledWith(
      "messages",
      expect.objectContaining({
        id: "msg-user-canceled",
        role: "user",
        content: "late user message",
      }),
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it("rejects unowned file IDs before inserting a new message", async () => {
    setupExistingMessage(null);
    mockCtx.db.get.mockResolvedValue({
      _id: "file-victim" as Id<"files">,
      user_id: "victim-user",
      is_attached: false,
    });

    const { saveMessage } = await import("../messages");

    await expect(
      saveMessage.handler(mockCtx, {
        serviceKey: SERVICE_KEY,
        id: "msg-unowned-file",
        chatId: CHAT_ID,
        userId: USER_ID,
        role: "user" as const,
        parts: [
          { type: "text", text: "read this" },
          { type: "file", fileId: "file-victim" as Id<"files"> },
        ],
        fileIds: ["file-victim" as Id<"files">],
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({
        code: "MESSAGE_SAVE_FAILED",
        failureStage: "validate_new_message_file_ownership",
        causeMessage: "File does not belong to user",
        fileValidationReason: "file_not_owned",
      }),
    });

    expect(mockCtx.db.insert).not.toHaveBeenCalled();
    expect(mockCtx.db.patch).not.toHaveBeenCalled();
  });

  it.each([
    ["missing row", "file_missing"],
    ["failed lookup", "file_lookup_failed"],
    ["different owner", "file_not_owned"],
  ])(
    "diagnoses %s without admitting an attached message",
    async (scenario, reason) => {
      setupExistingMessage(null);
      if (scenario === "failed lookup") {
        mockCtx.db.get.mockRejectedValue(new Error("lookup unavailable"));
      } else {
        mockCtx.db.get.mockResolvedValue(
          scenario === "different owner" ? { user_id: "other-user" } : null,
        );
      }
      const { saveMessage } = await import("../messages");
      await expect(
        saveMessage.handler(mockCtx, {
          serviceKey: SERVICE_KEY,
          id: "file-validation-message",
          chatId: CHAT_ID,
          userId: USER_ID,
          role: "user",
          parts: [{ type: "text", text: "attachment" }],
          fileIds: ["unavailable-file" as Id<"files">],
        }),
      ).rejects.toMatchObject({
        data: expect.objectContaining({
          code: "MESSAGE_SAVE_FAILED",
          failureStage: "validate_new_message_file_ownership",
          causeName: "Error",
          causeMessage:
            scenario === "different owner"
              ? "File does not belong to user"
              : "File not found",
          fileValidationReason: reason,
        }),
      });
      expect(mockCtx.db.insert).not.toHaveBeenCalled();
      expect(mockCtx.db.patch).not.toHaveBeenCalled();
      const structuredErrors = (console.error as jest.Mock).mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("{"),
      );
      expect(structuredErrors).toHaveLength(1);
      expect(JSON.parse(structuredErrors[0][0] as string)).toMatchObject({
        event: "convex_message_save_failed",
        file_validation_reason: reason,
      });
    },
  );

  const previewParts = (ids: string[]) => [
    {
      type: "tool-file",
      state: "output-available",
      output: {
        action: "view",
        previewFiles: ids.map((fileId) => ({ fileId, name: "preview.jpg" })),
      },
    },
  ];

  it("retains nested previews without caller-supplied file IDs", async () => {
    setupExistingMessage(null);
    mockCtx.db.get.mockResolvedValue({
      _id: "preview-1",
      user_id: USER_ID,
      is_attached: false,
    });
    const { saveMessage } = await import("../messages");
    await saveMessage.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      id: "preview-message",
      chatId: CHAT_ID,
      userId: USER_ID,
      role: "assistant",
      parts: [{ type: "tool-file", output: "[File: view preview.jpg]" }],
      previewFileIds: ["preview-1", "preview-1"],
    });
    expect(mockCtx.db.insert).toHaveBeenCalledWith(
      "messages",
      expect.objectContaining({ file_ids: ["preview-1"] }),
    );
    expect(mockCtx.db.patch).toHaveBeenCalledWith("preview-1", {
      is_attached: true,
    });
  });

  it("merges previews with existing attachments and repairs an unattached reference", async () => {
    setupExistingMessage(makeMessage({ file_ids: ["original", "preview-1"] }));
    mockCtx.db.get.mockImplementation(async (id: string) => ({
      _id: id,
      user_id: USER_ID,
      is_attached: id === "original",
    }));
    const { saveMessage } = await import("../messages");
    await saveMessage.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      id: "msg-1",
      chatId: CHAT_ID,
      userId: USER_ID,
      role: "assistant",
      parts: previewParts(["preview-1", "preview-2", "preview-2"]),
      fileIds: ["original" as Id<"files">, "preview-2" as Id<"files">],
    });
    expect(mockCtx.db.patch).toHaveBeenCalledWith(
      "msg-doc-1",
      expect.objectContaining({
        file_ids: ["original", "preview-1", "preview-2"],
      }),
    );
    for (const id of ["preview-1", "preview-2"]) {
      expect(mockCtx.db.patch).toHaveBeenCalledWith(id, { is_attached: true });
    }
    expect(mockCtx.db.patch).not.toHaveBeenCalledWith("original", {
      is_attached: true,
    });
  });

  it("keeps legacy messages saveable when previews are missing or malformed", async () => {
    setupExistingMessage(null);
    mockCtx.db.normalizeId.mockImplementation((_table: string, id: string) =>
      id === "malformed" ? null : id,
    );
    const { saveMessage } = await import("../messages");
    await expect(
      saveMessage.handler(mockCtx, {
        serviceKey: SERVICE_KEY,
        id: "legacy-message",
        chatId: CHAT_ID,
        userId: USER_ID,
        role: "assistant",
        parts: previewParts(["missing", "malformed"]),
      }),
    ).resolves.toBeNull();
    expect(mockCtx.db.insert).toHaveBeenCalled();
    expect(mockCtx.db.patch).not.toHaveBeenCalled();
    expect(mockCtx.db.get).not.toHaveBeenCalledWith("malformed");
  });

  it("rejects another user's preview before any writes", async () => {
    setupExistingMessage(null);
    mockCtx.db.get.mockResolvedValue({ _id: "preview-1", user_id: "other" });
    const { saveMessage } = await import("../messages");
    await expect(
      saveMessage.handler(mockCtx, {
        serviceKey: SERVICE_KEY,
        id: "unowned-preview-message",
        chatId: CHAT_ID,
        userId: USER_ID,
        role: "assistant",
        parts: previewParts(["preview-1"]),
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({
        failureStage: "verify_preview_file_ownership",
        causeMessage: "File does not belong to user",
      }),
    });
    expect(mockCtx.db.insert).not.toHaveBeenCalled();
    expect(mockCtx.db.patch).not.toHaveBeenCalled();
  });

  it("does not mistake a preview metadata read failure for a missing legacy file", async () => {
    setupExistingMessage(null);
    mockCtx.db.get.mockRejectedValue(new Error("database unavailable"));
    const { saveMessage } = await import("../messages");
    await expect(
      saveMessage.handler(mockCtx, {
        serviceKey: SERVICE_KEY,
        id: "preview-read-failure",
        chatId: CHAT_ID,
        userId: USER_ID,
        role: "assistant",
        parts: previewParts(["preview-1"]),
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({
        failureStage: "verify_preview_file_ownership",
        causeMessage: "database unavailable",
      }),
    });
    expect(mockCtx.db.insert).not.toHaveBeenCalled();
  });

  it("rejects unowned file IDs before updating an existing message", async () => {
    const existing = makeMessage({
      _id: "existing-doc" as Id<"messages">,
      file_ids: [],
    });
    setupExistingMessage(existing);
    mockCtx.db.get.mockResolvedValue({
      _id: "file-victim" as Id<"files">,
      user_id: "victim-user",
      is_attached: false,
    });

    const { saveMessage } = await import("../messages");

    await expect(
      saveMessage.handler(mockCtx, {
        serviceKey: SERVICE_KEY,
        id: "msg-1",
        chatId: CHAT_ID,
        userId: USER_ID,
        role: "user" as const,
        parts: [
          { type: "text", text: "read this" },
          { type: "file", fileId: "file-victim" as Id<"files"> },
        ],
        fileIds: ["file-victim" as Id<"files">],
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({
        code: "MESSAGE_SAVE_FAILED",
        failureStage: "validate_existing_message_file_ownership",
        causeMessage: "File does not belong to user",
        fileValidationReason: "file_not_owned",
      }),
    });

    expect(mockCtx.db.patch).not.toHaveBeenCalled();
  });
});

describe("getMessagesByChatId — is_hidden filtering", () => {
  let mockCtx: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});

    mockCtx = {
      auth: {
        getUserIdentity: jest.fn<any>().mockResolvedValue({ subject: USER_ID }),
      },
      db: {
        query: jest.fn(),
        get: jest.fn<any>().mockResolvedValue(null),
      },
      runQuery: jest.fn<any>().mockResolvedValue(true),
    };
  });

  function setupPaginatedMessages(messages: Record<string, any>[]) {
    const paginateMock = jest.fn<any>().mockResolvedValue({
      page: messages,
      isDone: true,
      continueCursor: "",
    });
    mockCtx.db.query.mockReturnValue({
      withIndex: jest.fn().mockReturnValue({
        order: jest.fn().mockReturnValue({
          paginate: paginateMock,
        }),
      }),
    });
    return paginateMock;
  }

  it.each([undefined, true])(
    "excludes hidden messages including takeover context (%s)",
    async (isBrowserHandoff) => {
      const visibleMsg = makeMessage({
        _id: "msg-doc-visible" as Id<"messages">,
        id: "msg-visible",
        role: "user",
      });
      const hiddenMsg = makeMessage({
        _id: "msg-doc-hidden" as Id<"messages">,
        id: "msg-hidden",
        role: "user",
        is_hidden: true,
        is_browser_handoff: isBrowserHandoff,
      });

      const paginateMock = setupPaginatedMessages([visibleMsg, hiddenMsg]);

      const { getMessagesByChatId } = await import("../messages");

      const result = await getMessagesByChatId.handler(mockCtx, {
        chatId: CHAT_ID,
        paginationOpts: { numItems: 10, cursor: null },
      });

      expect(result.page).toHaveLength(1);
      expect(result.page[0].id).toBe("msg-visible");
      expect(paginateMock).toHaveBeenCalledWith({
        numItems: 10,
        cursor: null,
        maximumBytesRead: 4 * 1024 * 1024,
      });
    },
  );

  it("should include messages where is_hidden is undefined or false", async () => {
    const msg1 = makeMessage({
      _id: "msg-doc-1" as Id<"messages">,
      id: "msg-1",
      role: "user",
      is_hidden: undefined,
    });
    const msg2 = makeMessage({
      _id: "msg-doc-2" as Id<"messages">,
      id: "msg-2",
      role: "assistant",
      is_hidden: false,
    });
    const msg3 = makeMessage({
      _id: "msg-doc-3" as Id<"messages">,
      id: "msg-3",
      role: "user",
      is_hidden: true,
    });

    setupPaginatedMessages([msg1, msg2, msg3]);

    const { getMessagesByChatId } = await import("../messages");

    const result = await getMessagesByChatId.handler(mockCtx, {
      chatId: CHAT_ID,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(result.page).toHaveLength(2);
    const ids = result.page.map((m: any) => m.id);
    expect(ids).toContain("msg-1");
    expect(ids).toContain("msg-2");
    expect(ids).not.toContain("msg-3");
  });

  it("does not read user attachment rows but preserves assistant file details", async () => {
    const userFileId = "file-user" as Id<"files">;
    const assistantFileId = "file-assistant" as Id<"files">;
    const feedbackId = "feedback-1" as Id<"feedback">;
    const userMessage = makeMessage({
      id: "msg-user-file",
      role: "user",
      parts: [
        {
          type: "file",
          fileId: userFileId,
          name: "request.txt",
          mediaType: "text/plain",
          size: 128,
        },
      ],
      file_ids: [userFileId],
    });
    const assistantMessage = makeMessage({
      id: "msg-assistant-file",
      role: "assistant",
      file_ids: [assistantFileId],
      feedback_id: feedbackId,
    });

    setupPaginatedMessages([assistantMessage, userMessage]);
    mockCtx.db.get.mockImplementation(async (id: string) => {
      if (id === userFileId) {
        throw new Error("user attachment row should not be read");
      }
      if (id === assistantFileId) {
        return {
          _id: assistantFileId,
          user_id: USER_ID,
          name: "artifact.zip",
          media_type: "application/zip",
          s3_key: "generated/artifact.zip",
          size: 2048,
          file_token_size: 0,
          is_attached: true,
        };
      }
      if (id === feedbackId) {
        return {
          _id: feedbackId,
          feedback_type: "positive",
        };
      }
      return null;
    });

    const { getMessagesByChatId } = await import("../messages");
    const result = await getMessagesByChatId.handler(mockCtx, {
      chatId: CHAT_ID,
      paginationOpts: { numItems: 10, cursor: null },
    });

    const assistantResult = result.page.find(
      (message: any) => message.id === "msg-assistant-file",
    );
    const userResult = result.page.find(
      (message: any) => message.id === "msg-user-file",
    );
    expect(mockCtx.db.get).not.toHaveBeenCalledWith(userFileId);
    expect(assistantResult?.fileDetails).toEqual([
      {
        fileId: assistantFileId,
        name: "artifact.zip",
        mediaType: "application/zip",
        s3Key: "generated/artifact.zip",
        sizeBytes: 2048,
      },
    ]);
    expect(assistantResult?.feedback).toEqual({
      feedbackType: "positive",
    });
    expect(userResult?.fileDetails).toBeUndefined();
  });
});

describe("getMessagesPageForBackend — is_hidden filtering", () => {
  let mockCtx: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});

    mockCtx = {
      db: {
        query: jest.fn(),
      },
      runQuery: jest.fn<any>().mockResolvedValue(true),
    };
  });

  function setupPaginatedMessages(
    messages: Record<string, any>[],
    chat: Record<string, any> | null = { id: CHAT_ID, user_id: USER_ID },
  ) {
    const paginateMock = jest.fn<any>().mockResolvedValue({
      page: messages,
      isDone: true,
      continueCursor: "",
    });
    mockCtx.db.query.mockImplementation((table: string) =>
      table === "chats"
        ? {
            withIndex: jest.fn().mockReturnValue({
              first: jest.fn<any>().mockResolvedValue(chat),
            }),
          }
        : {
            withIndex: jest.fn().mockReturnValue({
              order: jest.fn().mockReturnValue({
                paginate: paginateMock,
              }),
            }),
          },
    );
    return paginateMock;
  }

  it("rehydrates takeover context for a new Agent run while excluding auto-continue signals", async () => {
    setupPaginatedMessages([
      makeMessage({ id: "task" }),
      makeMessage({
        id: "note",
        is_hidden: true,
        is_browser_handoff: true,
        parts: [{ type: "text", text: "STOP! /LAB?X=YES café 日本語 😀" }],
      }),
      makeMessage({ id: "signal", is_hidden: true }),
    ]);
    const { getMessagesPageForBackend } = await import("../messages");
    const result = await getMessagesPageForBackend.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      chatId: CHAT_ID,
      userId: USER_ID,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(result.page.map((message: any) => message.id)).toEqual([
      "task",
      "note",
    ]);
    expect(result.page[1].parts).toEqual([
      { type: "text", text: "STOP! /LAB?X=YES café 日本語 😀" },
    ]);
  });

  it("returns routing provenance only for visible assistant messages, outside prompt parts", async () => {
    const seed = {
      abliterationRouting: {
        version: 1,
        source: "moderation",
        completed: true,
      },
    };
    setupPaginatedMessages([
      makeMessage({
        id: "independent",
        role: "assistant",
        finish_reason: "stop",
        usage: seed,
      }),
      makeMessage({
        id: "hidden",
        role: "assistant",
        is_hidden: true,
        finish_reason: "stop",
        usage: seed,
      }),
      makeMessage({
        id: "user",
        role: "user",
        finish_reason: "stop",
        usage: seed,
      }),
      makeMessage({
        id: "history",
        role: "assistant",
        finish_reason: "stop",
        usage: {
          abliterationRouting: {
            version: 1,
            source: "history",
            completed: true,
          },
        },
      }),
    ]);
    const { getMessagesPageForBackend } = await import("../messages");
    const result = await getMessagesPageForBackend.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      chatId: CHAT_ID,
      userId: USER_ID,
      paginationOpts: { numItems: 24, cursor: null },
    });
    expect(result.abliterationHistory).toEqual([
      { id: "independent", completed: true, independent: true },
      { id: "history", completed: true, independent: false },
    ]);
    expect(
      result.page.every((message: any) => message.usage === undefined),
    ).toBe(true);
  });

  it.each([
    [null, "CHAT_NOT_FOUND"],
    [{ id: CHAT_ID, user_id: "someone-else" }, "CHAT_UNAUTHORIZED"],
  ])("denies history when ownership fails (%s)", async (chat, code) => {
    const paginate = setupPaginatedMessages([], chat);
    const { getMessagesPageForBackend } = await import("../messages");
    await expect(
      getMessagesPageForBackend.handler(mockCtx, {
        serviceKey: SERVICE_KEY,
        chatId: CHAT_ID,
        userId: USER_ID,
        paginationOpts: { numItems: 24, cursor: null },
      }),
    ).rejects.toMatchObject({ data: { code } });
    expect(paginate).not.toHaveBeenCalled();
    expect(mockCtx.runQuery).not.toHaveBeenCalled();
  });

  it("should filter out hidden messages", async () => {
    const visibleMsg = makeMessage({
      id: "msg-visible",
      role: "assistant",
      parts: [{ type: "text", text: "visible" }],
    });
    const hiddenMsg = makeMessage({
      id: "msg-hidden",
      role: "user",
      parts: [{ type: "text", text: "hidden" }],
      is_hidden: true,
    });

    const paginateMock = setupPaginatedMessages([visibleMsg, hiddenMsg]);

    const { getMessagesPageForBackend } = await import("../messages");

    const result = await getMessagesPageForBackend.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      chatId: CHAT_ID,
      userId: USER_ID,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(result.page).toHaveLength(1);
    expect(mockCtx.runQuery).not.toHaveBeenCalled();
    expect(result.page[0].id).toBe("msg-visible");
    expect(result.fileTokens).toEqual([]);
    expect(paginateMock).toHaveBeenCalledWith({
      numItems: 10,
      cursor: null,
      maximumBytesRead: 4 * 1024 * 1024,
    });
  });

  it("should keep messages where is_hidden is false or undefined", async () => {
    const msg1 = makeMessage({
      id: "msg-a",
      role: "user",
      parts: [{ type: "text", text: "a" }],
      is_hidden: false,
    });
    const msg2 = makeMessage({
      id: "msg-b",
      role: "assistant",
      parts: [{ type: "text", text: "b" }],
      is_hidden: undefined,
    });
    const msg3 = makeMessage({
      id: "msg-c",
      role: "system",
      parts: [{ type: "text", text: "c" }],
      is_hidden: true,
    });

    setupPaginatedMessages([msg1, msg2, msg3]);

    const { getMessagesPageForBackend } = await import("../messages");

    const result = await getMessagesPageForBackend.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      chatId: CHAT_ID,
      userId: USER_ID,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(result.page).toHaveLength(2);
    const ids = result.page.map((m: any) => m.id);
    expect(ids).toContain("msg-a");
    expect(ids).toContain("msg-b");
    expect(ids).not.toContain("msg-c");
  });

  it("reuses ownership reads as verified file token metadata", async () => {
    const fileId = "file-owned" as Id<"files">;
    const message = makeMessage({
      id: "msg-with-file",
      role: "user",
      parts: [{ type: "file", fileId }],
    });
    setupPaginatedMessages([message]);
    mockCtx.db.get = jest.fn<any>().mockResolvedValue({
      _id: fileId,
      user_id: USER_ID,
      file_token_size: 321,
    });

    const { getMessagesPageForBackend } = await import("../messages");
    const result = await getMessagesPageForBackend.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      chatId: CHAT_ID,
      userId: USER_ID,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(result.page[0].parts).toEqual([{ type: "file", fileId }]);
    expect(result.fileTokens).toEqual([{ fileId, tokenSize: 321 }]);
    expect(mockCtx.db.get).toHaveBeenCalledTimes(1);
  });
});

describe("client stop-save routing provenance", () => {
  const makeClientContext = () => ({
    auth: {
      getUserIdentity: jest.fn<any>().mockResolvedValue({ subject: USER_ID }),
    },
    runQuery: jest.fn<any>().mockResolvedValue(true),
    db: {
      query: jest.fn().mockReturnValue({
        withIndex: jest.fn().mockReturnValue({
          first: jest.fn<any>().mockResolvedValue(null),
        }),
      }),
      insert: jest.fn<any>().mockResolvedValue("doc"),
    },
  });

  it("fits the whole insert without shortening canonical multibyte text", async () => {
    const { saveAssistantMessage } = await import("../messages");
    const { getDocumentSize } = await import("convex/values");
    const ctx = makeClientContext();
    const text = "🙂".repeat(150_000);
    const parts = [{ type: "text", text }];
    await saveAssistantMessage.handler(ctx as any, {
      id: "large-client-text",
      chatId: CHAT_ID,
      role: "assistant",
      parts,
    });
    const document = ctx.db.insert.mock.calls[0][1];
    expect(document.parts).toEqual(parts);
    expect(document.content.length).toBeGreaterThan(256);
    expect(document.content.length).toBeLessThan(text.length);
    expect(document.content.endsWith("🙂")).toBe(true);
    expect(getDocumentSize(document)).toBeLessThanOrEqual(960 * 1024);
  });

  it("rejects aggregate oversized parts before native insert with bounded diagnostics", async () => {
    const { saveAssistantMessage } = await import("../messages");
    const { getConvexSize } = await import("convex/values");
    const ctx = makeClientContext();
    const parts = [
      { type: "text", text: "private-first" + "x".repeat(510 * 1024) },
      { type: "text", text: "private-second" + "x".repeat(510 * 1024) },
    ];
    const error = await saveAssistantMessage
      .handler(ctx as any, {
        id: "oversized-client-parts",
        chatId: CHAT_ID,
        role: "assistant",
        parts,
      })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      data: {
        code: "MESSAGE_TOO_LARGE",
        operation: "messages.saveAssistantMessage",
        failureStage: "prepare_insert_message",
        maxDocumentSizeBytes: 1024 * 1024,
        targetDocumentSizeBytes: 960 * 1024,
        partCount: 2,
        partDiagnostics: {
          partsSizeBytes: getConvexSize(parts),
          largestPartCategory: "text",
          largestPartSizeBytes: getConvexSize(parts[1]),
          categories: {
            text: { count: 2, sizeBytes: getConvexSize(parts) - 2 },
          },
        },
      },
    });
    expect(JSON.stringify(error)).not.toContain("private-first");
    expect(JSON.stringify(error)).not.toContain("private-second");
    expect(ctx.db.insert).not.toHaveBeenCalled();
  });

  it("reports UTF-8 part bytes without leaking arbitrary names or values", async () => {
    const { saveAssistantMessage } = await import("../messages");
    const { getConvexSize } = await import("convex/values");
    const ctx = makeClientContext();
    const parts = [
      { type: "reasoning", text: "🙂".repeat(270_000) },
      { type: "tool-private-tool", output: "private-output" },
      {
        type: "dynamic-tool",
        toolName: "private-name",
        input: "private-input",
      },
      { type: "data-private-data", data: { privateKey: "private-value" } },
      { type: "private-unknown", value: 1n },
      { type: 123, value: new ArrayBuffer(10) },
      { type: "file", url: "private-url" },
      { type: "step-start" },
      {},
    ];
    const error = await saveAssistantMessage
      .handler(ctx as any, {
        id: "private-message-id",
        chatId: CHAT_ID,
        role: "assistant",
        parts,
      })
      .catch((reason: any) => reason);
    expect(error).toMatchObject({
      message: "Message is too large to save",
      data: {
        code: "MESSAGE_TOO_LARGE",
        partDiagnostics: {
          partsSizeBytes: getConvexSize(parts),
          largestPartCategory: "reasoning",
          largestPartSizeBytes: getConvexSize(parts[0]),
          categories: {
            reasoning: { count: 1, sizeBytes: getConvexSize(parts[0]) },
            tool: { count: 2 },
            data: { count: 1 },
            other: { count: 3 },
            file: { count: 1 },
            "step-start": { count: 1 },
          },
        },
      },
    });
    expect(error.data.partDiagnostics.partsSizeBytes).toBeGreaterThan(
      1_080_000,
    );
    expect(JSON.stringify(error)).not.toMatch(/private|🙂/);
    expect(JSON.stringify(error).length).toBeLessThan(1500);
    expect(ctx.db.insert).not.toHaveBeenCalled();
  });

  it("keeps stop-save authentication and ownership ahead of insert", async () => {
    const { saveAssistantMessage } = await import("../messages");
    const ctx = makeClientContext();
    ctx.runQuery.mockResolvedValue(false);
    await expect(
      saveAssistantMessage.handler(ctx as any, {
        id: "foreign-client",
        chatId: CHAT_ID,
        role: "assistant",
        parts: [],
      }),
    ).rejects.toThrow("Chat not found");
    expect(ctx.db.insert).not.toHaveBeenCalled();
    ctx.auth.getUserIdentity.mockResolvedValue(null);
    ctx.runQuery.mockClear();
    await expect(
      saveAssistantMessage.handler(ctx as any, {
        id: "signed-out",
        chatId: CHAT_ID,
        role: "assistant",
        parts: [],
      }),
    ).rejects.toThrow("Unauthorized");
    expect(ctx.runQuery).not.toHaveBeenCalled();
  });

  it("includes metadata in the aggregate bound and keeps duplicate saves idempotent", async () => {
    const { saveAssistantMessage } = await import("../messages");
    const ctx = makeClientContext();
    const args = {
      id: "metadata-heavy",
      chatId: CHAT_ID,
      role: "assistant" as const,
      parts: [{ type: "text", text: "x".repeat(510 * 1024) }],
      usage: { opaqueProviderMetadata: "y".repeat(510 * 1024) },
    };
    await expect(
      saveAssistantMessage.handler(ctx as any, args),
    ).rejects.toMatchObject({ data: { code: "MESSAGE_TOO_LARGE" } });
    expect(ctx.db.insert).not.toHaveBeenCalled();
    ctx.db.query.mockReturnValue({
      withIndex: jest.fn().mockReturnValue({
        first: jest.fn<any>().mockResolvedValue({ id: args.id }),
      }),
    });
    await expect(
      saveAssistantMessage.handler(ctx as any, args),
    ).resolves.toBeNull();
    expect(ctx.db.insert).not.toHaveBeenCalled();
  });

  it("cannot insert routing evidence through client usage", async () => {
    const { saveAssistantMessage } = await import("../messages");
    const insert = jest.fn<any>().mockResolvedValue("doc");
    const ctx = {
      auth: {
        getUserIdentity: jest.fn<any>().mockResolvedValue({ subject: USER_ID }),
      },
      runQuery: jest.fn<any>().mockResolvedValue(true),
      db: {
        query: jest.fn().mockReturnValue({
          withIndex: jest.fn().mockReturnValue({
            first: jest.fn<any>().mockResolvedValue(null),
          }),
        }),
        insert,
      },
    };
    await saveAssistantMessage.handler(ctx as any, {
      id: "client",
      chatId: CHAT_ID,
      role: "assistant",
      parts: [{ type: "text", text: "ok" }],
      finishReason: "stop",
      usage: {
        inputTokens: 5,
        abliterationRouting: {
          version: 1,
          source: "moderation",
          completed: true,
        },
      },
    });
    expect(insert).toHaveBeenCalledWith(
      "messages",
      expect.objectContaining({ usage: { inputTokens: 5 } }),
    );
  });
});

describe("isUserMessagePersisted", () => {
  const check = async (message: any, identity: any = { subject: USER_ID }) => {
    const first = jest
      .fn<any>()
      .mockResolvedValueOnce(message)
      .mockResolvedValueOnce({ user_id: USER_ID });
    const ctx = {
      auth: { getUserIdentity: async () => identity },
      db: { query: () => ({ withIndex: () => ({ first }) }) },
    };
    const { isUserMessagePersisted } = await import("../messages");
    return (isUserMessagePersisted as any).handler(ctx, {
      chatId: CHAT_ID,
      messageId: "msg-1",
    });
  };

  it("checks saved turns independently of any client history page", async () => {
    await expect(check(makeMessage())).resolves.toBe(true);
  });
  it("allows an absent turn before the first chat write", async () => {
    await expect(check(null)).resolves.toBe(false);
  });
  it.each([{ user_id: "another-user" }, { chat_id: "another-chat" }])(
    "rejects a message outside the authenticated chat: %j",
    async (overrides) => {
      await expect(check(makeMessage(overrides))).rejects.toThrow(
        "Unauthorized",
      );
    },
  );
  it("requires authentication even for a missing message", async () => {
    await expect(check(null, null)).rejects.toThrow("Unauthorized");
  });
});
