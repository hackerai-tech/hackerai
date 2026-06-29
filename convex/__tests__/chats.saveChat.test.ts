import { describe, expect, it, jest } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: any) => config),
  internalMutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
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

jest.mock("convex/server", () => ({
  paginationOptsValidator: "paginationOptsValidator",
}));

jest.mock("../_generated/api", () => ({
  internal: {
    chats: {
      cleanupChatSummaryTelemetryBatch:
        "internal.chats.cleanupChatSummaryTelemetryBatch",
    },
  },
}));

jest.mock("../fileAggregate", () => ({
  fileCountAggregate: {
    deleteIfExists: jest.fn<any>().mockResolvedValue(undefined),
  },
}));

jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));

jest.mock("../lib/suspensionGuards", () => ({
  assertUserCanAccessChatHistory: jest.fn<any>().mockResolvedValue(undefined),
}));

const SERVICE_KEY = "test-service-key";
process.env.CONVEX_SERVICE_ROLE_KEY = SERVICE_KEY;

const saveChatArgs = {
  serviceKey: SERVICE_KEY,
  id: "chat-1",
  userId: "user-1",
  title: "hello",
};

const makeCtx = ({
  existingChat,
  insertResult = "chat-doc-1",
}: {
  existingChat?: Record<string, unknown> | null;
  insertResult?: string;
}) => {
  const unique = jest.fn<any>().mockResolvedValue(existingChat ?? null);
  const first = jest.fn<any>().mockResolvedValue(existingChat ?? null);
  const indexEq = jest.fn();
  const withIndex = jest.fn((_indexName: string, build: (q: any) => any) => {
    const q = {
      eq: jest.fn((field: string, value: unknown) => {
        indexEq(field, value);
        return q;
      }),
    };
    build(q);
    return { first, unique };
  });
  const query = jest.fn(() => ({ withIndex }));
  const insert = jest.fn<any>().mockResolvedValue(insertResult);

  return {
    ctx: {
      db: {
        query,
        insert,
      },
    } as any,
    first,
    indexEq,
    insert,
    query,
    unique,
    withIndex,
  };
};

describe("saveChat", () => {
  it("uses unique chat id lookup before inserting", async () => {
    const { saveChat } = await import("../chats");
    const { ctx, first, indexEq, insert, unique, withIndex } = makeCtx({});

    await expect(saveChat.handler(ctx, saveChatArgs)).resolves.toBe(
      "chat-doc-1",
    );

    expect(withIndex).toHaveBeenCalledWith("by_chat_id", expect.any(Function));
    expect(indexEq).toHaveBeenCalledWith("id", "chat-1");
    expect(unique).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith("chats", {
      id: "chat-1",
      title: "hello",
      user_id: "user-1",
      update_time: expect.any(Number),
    });
  });

  it("wraps unexpected insert failures with chat save metadata", async () => {
    const { saveChat } = await import("../chats");
    const { ctx, insert } = makeCtx({});
    insert.mockRejectedValueOnce(new Error("write failed"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(saveChat.handler(ctx, saveChatArgs)).rejects.toMatchObject({
        name: "ConvexError",
        data: expect.objectContaining({
          code: "CHAT_SAVE_FAILED",
          message: "Failed to save chat",
          failureStage: "insert_chat",
          causeName: "Error",
          causeMessage: "write failed",
          operation: "chats.saveChat",
          chatId: "chat-1",
          titleLength: 5,
        }),
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("preserves structured Convex cause metadata on insert failures", async () => {
    const { ConvexError } = await import("convex/values");
    const { saveChat } = await import("../chats");
    const { ctx, insert } = makeCtx({});
    insert.mockRejectedValueOnce(
      new ConvexError({
        code: "DB_WRITE_FAILED",
        requestId: "req-123",
      }),
    );
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(saveChat.handler(ctx, saveChatArgs)).rejects.toMatchObject({
        name: "ConvexError",
        data: expect.objectContaining({
          code: "CHAT_SAVE_FAILED",
          failureStage: "insert_chat",
          causeData: {
            code: "DB_WRITE_FAILED",
            requestId: "req-123",
          },
          operation: "chats.saveChat",
          chatId: "chat-1",
          titleLength: 5,
        }),
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rethrows existing-chat ownership denials without wrapping them", async () => {
    const { saveChat } = await import("../chats");
    const { ctx, indexEq, insert, withIndex } = makeCtx({
      existingChat: {
        _id: "chat-doc-1",
        id: "chat-1",
        user_id: "other-user",
      },
    });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const thrown = await saveChat
        .handler(ctx, saveChatArgs)
        .catch((error: unknown) => error);

      expect(thrown).toMatchObject({
        name: "ConvexError",
        data: {
          code: "CHAT_UNAUTHORIZED",
          message: "Chat id belongs to another user",
          operation: "chats.saveChat",
          chatId: "chat-1",
        },
      });
      expect(withIndex).toHaveBeenCalledWith(
        "by_chat_id",
        expect.any(Function),
      );
      expect(indexEq).toHaveBeenCalledWith("id", "chat-1");
      expect(insert).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
