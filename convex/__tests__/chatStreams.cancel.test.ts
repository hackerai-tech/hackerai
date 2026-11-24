import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../lib/serviceFunctions", () => ({
  mutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
}));

jest.mock("convex/values", () => ({
  v: {
    array: jest.fn(() => "array"),
    boolean: jest.fn(() => "boolean"),
    literal: jest.fn(() => "literal"),
    null: jest.fn(() => "null"),
    number: jest.fn(() => "number"),
    object: jest.fn(() => "object"),
    optional: jest.fn(() => "optional"),
    string: jest.fn(() => "string"),
    union: jest.fn(() => "union"),
  },
  ConvexError: class ConvexError extends Error {
    data: unknown;

    constructor(data: any) {
      super(typeof data === "string" ? data : data.message);
      this.data = data;
    }
  },
}));

jest.mock("../_generated/api", () => ({
  internal: {
    redisPubsub: {
      publishCancellation: "internal.redisPubsub.publishCancellation",
    },
  },
}));

jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));

jest.mock("../lib/logger", () => ({
  convexLogger: { warn: jest.fn() },
}));

const mockAssertChatHistoryOwner = jest.fn(async () => undefined);
jest.mock("../lib/chatHistoryAccess", () => ({
  assertChatHistoryOwner: (...args: unknown[]) =>
    mockAssertChatHistoryOwner(...(args as [])),
}));

const mockAssertCanAccessHistory = jest.fn(async () => undefined);
jest.mock("../lib/suspensionGuards", () => ({
  assertUserCanAccessChatHistory: (...args: unknown[]) =>
    mockAssertCanAccessHistory(...(args as [])),
}));

const todos = [
  {
    id: "todo-1",
    content: "Keep this task",
    status: "in_progress" as const,
    sourceMessageId: "assistant-1",
  },
];

const makeCtx = (chat: Record<string, unknown>) => {
  const patch = jest.fn(async () => undefined);
  const runAfter = jest.fn(async () => undefined);
  const first = jest.fn(async () => chat);
  const withIndex = jest.fn((_name: string, build: (q: any) => unknown) => {
    const q = { eq: jest.fn(() => q) };
    build(q);
    return { first };
  });

  return {
    ctx: {
      auth: {
        getUserIdentity: jest.fn(async () => ({ subject: "user-1" })),
      },
      db: {
        patch,
        query: jest.fn(() => ({ withIndex })),
      },
      scheduler: { runAfter },
    } as any,
    patch,
    runAfter,
  };
};

describe("cancelStreamFromClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("persists the current todos atomically with stream cancellation", async () => {
    const { cancelStreamFromClient } = await import("../chatStreams");
    const { ctx, patch, runAfter } = makeCtx({
      _id: "chat-doc-1",
      id: "chat-1",
      user_id: "user-1",
      active_stream_id: "stream-1",
    });

    // A running stream is the Ask acknowledgment for the Stop marker.
    expect(
      await cancelStreamFromClient.handler(ctx, {
        chatId: "chat-1",
        todos,
      }),
    ).toBe(true);

    expect(patch).toHaveBeenCalledWith(
      "chat-doc-1",
      expect.objectContaining({
        active_stream_id: undefined,
        canceled_at: expect.any(Number),
        finish_reason: undefined,
        last_run_finished_at: expect.any(Number),
        todos,
      }),
    );
    expect(runAfter).toHaveBeenCalledWith(
      0,
      "internal.redisPubsub.publishCancellation",
      { chatId: "chat-1", skipSave: undefined },
    );
  });

  it("still persists todos when the stream was already marked canceled", async () => {
    const { cancelStreamFromClient } = await import("../chatStreams");
    const { ctx, patch } = makeCtx({
      _id: "chat-doc-1",
      id: "chat-1",
      user_id: "user-1",
      active_stream_id: undefined,
      canceled_at: 123,
    });

    // Nothing was running, so this Stop must not be reported as ending a run.
    expect(
      await cancelStreamFromClient.handler(ctx, {
        chatId: "chat-1",
        todos,
      }),
    ).toBe(false);

    expect(patch).toHaveBeenCalledWith("chat-doc-1", { todos });
    const update = patch.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(update).not.toHaveProperty("last_run_finished_at");
  });

  it("preserves the stored plan when cancellation omits the optional snapshot", async () => {
    const { cancelStreamFromClient } = await import("../chatStreams");
    const { ctx, patch, runAfter } = makeCtx({
      _id: "chat-doc-1",
      id: "chat-1",
      user_id: "user-1",
      active_stream_id: "stream-1",
      todos,
    });

    await cancelStreamFromClient.handler(ctx, { chatId: "chat-1" });

    expect(patch).toHaveBeenCalledWith(
      "chat-doc-1",
      expect.objectContaining({
        active_stream_id: undefined,
        canceled_at: expect.any(Number),
      }),
    );
    expect(patch.mock.calls[0]?.[1]).not.toHaveProperty("todos");
    expect(runAfter).toHaveBeenCalledWith(
      0,
      "internal.redisPubsub.publishCancellation",
      { chatId: "chat-1", skipSave: undefined },
    );
  });
});

type Row = Record<string, unknown> & { _id: string; id: string };

const ownedChat: Row = { _id: "chat-doc-1", id: "chat-1", user_id: "user-1" };
const request: Row = {
  _id: "doc-user-1",
  id: "user-1",
  chat_id: "chat-1",
  user_id: "user-1",
  role: "user",
};
const partialReply: Row = {
  _id: "doc-assistant-1",
  id: "assistant-1",
  chat_id: "chat-1",
  user_id: "user-1",
  role: "assistant",
};

/** Messages are listed in creation order, as the by_chat_id index stores them. */
const makeStopCtx = (rows: Row[], chat: Row = ownedChat) => {
  const patch = jest.fn(async () => undefined);
  const messages = rows.map((row, index) => ({ ...row, _creationTime: index }));
  const query = jest.fn((table: string) => ({
    withIndex: (index: string, build: (q: any) => unknown) => {
      let value: unknown;
      let after = -1;
      const q = {
        eq: (_field: string, next: unknown) => {
          value = next;
          return q;
        },
        gt: (_field: string, time: number) => {
          after = time;
          return q;
        },
      };
      build(q);
      if (table === "chats")
        return { first: async () => (chat.id === value ? chat : null) };
      if (index === "by_message_id")
        return {
          first: async () => messages.find((row) => row.id === value) ?? null,
        };
      return {
        take: async (limit: number) =>
          messages
            .filter((row) => row.chat_id === value && row._creationTime > after)
            .slice(0, limit),
      };
    },
  }));
  return {
    ctx: {
      auth: {
        getUserIdentity: jest.fn(async () => ({ subject: "user-1" })),
      },
      db: { patch, query },
    } as any,
    patch,
  };
};

describe("markMessageUserStopped", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    {
      label: "partial reply",
      rows: [request, partialReply],
      anchor: partialReply,
    },
    { label: "request with no saved reply", rows: [request], anchor: request },
    {
      label: "reply followed only by a hidden auto-continue row",
      rows: [
        request,
        partialReply,
        { ...request, _id: "doc-hidden", id: "hidden-1", is_hidden: true },
      ],
      anchor: partialReply,
    },
  ])("records the Stop on the $label", async ({ rows, anchor }) => {
    const { markMessageUserStopped } = await import("../chatStreams");
    const { ctx, patch } = makeStopCtx(rows);

    expect(
      await markMessageUserStopped.handler(ctx, {
        chatId: "chat-1",
        messageId: anchor.id,
        role: anchor.role as "user" | "assistant",
      }),
    ).toBe(true);
    expect(patch).toHaveBeenCalledWith(anchor._id, { user_stopped: true });
    expect(mockAssertCanAccessHistory).toHaveBeenCalledWith(ctx, "user-1");
    expect(mockAssertChatHistoryOwner).toHaveBeenCalledWith(
      ctx,
      "chat-1",
      "user-1",
    );
  });

  it.each([
    {
      label: "the reply already finished normally",
      rows: [request, { ...partialReply, finish_reason: "stop" }],
      anchor: partialReply,
    },
    {
      label: "the reply already ended at a time limit",
      rows: [request, { ...partialReply, finish_reason: "timeout" }],
      anchor: partialReply,
    },
    {
      label: "a reply was saved after the request anchor",
      rows: [request, partialReply],
      anchor: request,
    },
    {
      label: "a newer request started",
      rows: [
        request,
        partialReply,
        { ...request, _id: "doc-user-2", id: "user-2" },
      ],
      anchor: partialReply,
    },
    {
      label: "the role does not match",
      rows: [request, partialReply],
      anchor: { ...partialReply, role: "user" },
    },
    {
      label: "the message belongs to another chat",
      rows: [request, { ...partialReply, chat_id: "chat-2" }],
      anchor: partialReply,
    },
    {
      label: "the message was never saved",
      rows: [request],
      anchor: partialReply,
    },
  ])(
    "refuses a stale or false marker when $label",
    async ({ rows, anchor }) => {
      const { markMessageUserStopped } = await import("../chatStreams");
      const { ctx, patch } = makeStopCtx(rows);

      expect(
        await markMessageUserStopped.handler(ctx, {
          chatId: "chat-1",
          messageId: anchor.id,
          role: anchor.role as "user" | "assistant",
        }),
      ).toBe(false);
      expect(patch).not.toHaveBeenCalled();
    },
  );

  it("is idempotent for a repeated Stop", async () => {
    const { markMessageUserStopped } = await import("../chatStreams");
    const { ctx, patch } = makeStopCtx([
      request,
      { ...partialReply, user_stopped: true },
      { ...request, _id: "doc-user-2", id: "user-2" },
    ]);

    expect(
      await markMessageUserStopped.handler(ctx, {
        chatId: "chat-1",
        messageId: "assistant-1",
        role: "assistant",
      }),
    ).toBe(true);
    expect(patch).not.toHaveBeenCalled();
  });

  it("rejects another user's chat", async () => {
    const { markMessageUserStopped } = await import("../chatStreams");
    const { ctx, patch } = makeStopCtx([request, partialReply], {
      ...ownedChat,
      user_id: "user-2",
    });

    await expect(
      markMessageUserStopped.handler(ctx, {
        chatId: "chat-1",
        messageId: "assistant-1",
        role: "assistant",
      }),
    ).rejects.toMatchObject({ data: { code: "ACCESS_DENIED" } });
    expect(patch).not.toHaveBeenCalled();
  });
});

describe("prepareForNewStream", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("records the finish time when terminal cleanup clears a stream", async () => {
    const { prepareForNewStream } = await import("../chatStreams");
    const { ctx, patch } = makeCtx({
      _id: "chat-doc-1",
      id: "chat-1",
      user_id: "user-1",
      active_stream_id: "stream-1",
    });

    await prepareForNewStream.handler(ctx, {
      serviceKey: "service-key",
      chatId: "chat-1",
    });

    expect(patch).toHaveBeenCalledWith("chat-doc-1", {
      active_stream_id: undefined,
      canceled_at: undefined,
      last_run_finished_at: expect.any(Number),
    });
  });
});
