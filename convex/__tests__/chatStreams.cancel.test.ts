import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../_generated/server", () => ({
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

    await cancelStreamFromClient.handler(ctx, {
      chatId: "chat-1",
      todos,
    });

    expect(patch).toHaveBeenCalledWith(
      "chat-doc-1",
      expect.objectContaining({
        active_stream_id: undefined,
        canceled_at: expect.any(Number),
        finish_reason: undefined,
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

    await cancelStreamFromClient.handler(ctx, {
      chatId: "chat-1",
      todos,
    });

    expect(patch).toHaveBeenCalledWith("chat-doc-1", { todos });
  });
});
