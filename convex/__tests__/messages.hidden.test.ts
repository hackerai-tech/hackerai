import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Id } from "../_generated/dataModel";

jest.mock("../_generated/server", () => ({
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
  isUserBlockedByActiveFraudDispute: jest.fn<any>().mockResolvedValue(false),
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
      }),
    });

    expect(mockCtx.db.insert).not.toHaveBeenCalled();
    expect(mockCtx.db.patch).not.toHaveBeenCalled();
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

  function setupPaginatedMessages(messages: Record<string, any>[]): void {
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
  }

  it("should exclude messages where is_hidden is true", async () => {
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
    });

    setupPaginatedMessages([visibleMsg, hiddenMsg]);

    const { getMessagesByChatId } = await import("../messages");

    const result = await getMessagesByChatId.handler(mockCtx, {
      chatId: CHAT_ID,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(result.page).toHaveLength(1);
    expect(result.page[0].id).toBe("msg-visible");
  });

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

  function setupPaginatedMessages(messages: Record<string, any>[]): void {
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
  }

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

    setupPaginatedMessages([visibleMsg, hiddenMsg]);

    const { getMessagesPageForBackend } = await import("../messages");

    const result = await getMessagesPageForBackend.handler(mockCtx, {
      serviceKey: SERVICE_KEY,
      chatId: CHAT_ID,
      userId: USER_ID,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(result.page).toHaveLength(1);
    expect(result.page[0].id).toBe("msg-visible");
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
});
