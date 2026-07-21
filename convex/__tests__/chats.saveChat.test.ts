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
  project,
  authenticatedUserId = "user-1",
}: {
  existingChat?: Record<string, unknown> | null;
  insertResult?: string;
  project?: Record<string, unknown> | null;
  authenticatedUserId?: string | null;
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
  const normalizeId = jest.fn<any>((_table: string, id: string) => id);
  const get = jest.fn<any>().mockResolvedValue(project ?? null);
  const patch = jest.fn<any>().mockResolvedValue(undefined);

  return {
    ctx: {
      auth: {
        getUserIdentity: jest
          .fn<any>()
          .mockResolvedValue(
            authenticatedUserId ? { subject: authenticatedUserId } : null,
          ),
      },
      db: {
        get,
        normalizeId,
        patch,
        query,
        insert,
      },
    } as any,
    first,
    indexEq,
    insert,
    get,
    normalizeId,
    patch,
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

  it("associates a new chat with an owned project", async () => {
    const { saveChat } = await import("../chats");
    const { ctx, get, insert, normalizeId, patch } = makeCtx({
      project: { _id: "project-1", user_id: "user-1" },
    });

    await expect(
      saveChat.handler(ctx, { ...saveChatArgs, projectId: "project-1" }),
    ).resolves.toBe("chat-doc-1");

    expect(normalizeId).toHaveBeenCalledWith("projects", "project-1");
    expect(get).toHaveBeenCalledWith("project-1");
    expect(insert).toHaveBeenCalledWith(
      "chats",
      expect.objectContaining({ project_id: "project-1" }),
    );
    expect(patch).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ updated_at: expect.any(Number) }),
    );
  });

  it("rejects a project owned by another user", async () => {
    const { saveChat } = await import("../chats");
    const { ctx, insert, patch } = makeCtx({
      project: { _id: "project-1", user_id: "other-user" },
    });

    await expect(
      saveChat.handler(ctx, { ...saveChatArgs, projectId: "project-1" }),
    ).rejects.toMatchObject({
      name: "ConvexError",
      data: expect.objectContaining({ code: "PROJECT_ACCESS_DENIED" }),
    });
    expect(insert).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
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
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [logLine] = errorSpy.mock.calls[0] ?? [];
      expect(JSON.parse(String(logLine))).toMatchObject({
        event: "convex_chat_save_failed",
        db_operation: "chats.saveChat",
        failure_stage: "insert_chat",
        convex_error_data: {
          code: "DB_WRITE_FAILED",
          requestId: "req-123",
        },
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

describe("updateChatTitle", () => {
  it("updates the sidebar title without clearing active stream state", async () => {
    const { updateChatTitle } = await import("../chats");
    const { ctx, patch } = makeCtx({
      existingChat: {
        _id: "chat-doc-1",
        id: "chat-1",
        user_id: "user-1",
        active_stream_id: "stream-1",
        canceled_at: 123,
      },
    });

    await expect(
      updateChatTitle.handler(ctx, {
        serviceKey: SERVICE_KEY,
        chatId: "chat-1",
        title: "  Generated Sidebar Title  ",
      }),
    ).resolves.toBeNull();

    expect(patch).toHaveBeenCalledWith("chat-doc-1", {
      title: "Generated Sidebar Title",
      update_time: expect.any(Number),
    });
    const update = patch.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(update).not.toHaveProperty("active_stream_id");
    expect(update).not.toHaveProperty("canceled_at");
  });

  it("does nothing if the chat was deleted while its title generated", async () => {
    const { updateChatTitle } = await import("../chats");
    const { ctx, patch } = makeCtx({ existingChat: null });

    await expect(
      updateChatTitle.handler(ctx, {
        serviceKey: SERVICE_KEY,
        chatId: "deleted-chat",
        title: "Generated Title",
      }),
    ).resolves.toBeNull();

    expect(patch).not.toHaveBeenCalled();
  });
});

describe("moveChatToProject", () => {
  it("moves an owned chat to an owned project", async () => {
    const { moveChatToProject } = await import("../chats");
    const { ctx, get, patch } = makeCtx({
      existingChat: {
        _id: "chat-doc-1",
        id: "chat-1",
        user_id: "user-1",
      },
      project: { _id: "project-1", user_id: "user-1" },
    });

    await expect(
      moveChatToProject.handler(ctx, {
        chatId: "chat-1",
        projectId: "project-1" as any,
      }),
    ).resolves.toBe(true);

    expect(get).toHaveBeenCalledWith("project-1");
    expect(patch).toHaveBeenCalledWith("chat-doc-1", {
      project_id: "project-1",
      update_time: expect.any(Number),
    });
    expect(patch).toHaveBeenCalledWith("project-1", {
      updated_at: expect.any(Number),
    });
  });

  it("rejects moving another user's chat", async () => {
    const { moveChatToProject } = await import("../chats");
    const { ctx, patch } = makeCtx({
      existingChat: {
        _id: "chat-doc-1",
        id: "chat-1",
        user_id: "other-user",
      },
      project: { _id: "project-1", user_id: "user-1" },
    });

    await expect(
      moveChatToProject.handler(ctx, {
        chatId: "chat-1",
        projectId: "project-1" as any,
      }),
    ).rejects.toMatchObject({
      name: "ConvexError",
      data: expect.objectContaining({ code: "ACCESS_DENIED" }),
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it("removes an owned chat from its project", async () => {
    const { moveChatToProject } = await import("../chats");
    const { ctx, get, patch } = makeCtx({
      existingChat: {
        _id: "chat-doc-1",
        id: "chat-1",
        user_id: "user-1",
        project_id: "project-1",
      },
    });

    await expect(
      moveChatToProject.handler(ctx, {
        chatId: "chat-1",
        projectId: null,
      }),
    ).resolves.toBe(true);

    expect(get).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledWith("chat-doc-1", {
      project_id: undefined,
      update_time: expect.any(Number),
    });
  });
});
