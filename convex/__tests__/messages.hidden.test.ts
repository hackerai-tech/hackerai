import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Id } from "../_generated/dataModel";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: any) => config),
  internalMutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
  internalQuery: jest.fn((config: any) => config),
}));
jest.mock("convex/values", () => ({
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
}));
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

  function setupExistingMessage(msg: Record<string, any> | null): void {
    const withIndexMock = jest.fn().mockReturnValue({
      first: jest.fn<any>().mockResolvedValue(msg),
    });
    mockCtx.db.query.mockReturnValue({ withIndex: withIndexMock });
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
