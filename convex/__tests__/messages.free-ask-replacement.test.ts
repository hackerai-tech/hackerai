import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * Exercises the real deletion handlers against an in-memory message/chat
 * store. Only Convex framework wrappers, auth guards and side services are
 * mocked at their boundary.
 */
jest.mock("../lib/serviceFunctions", () => ({
  mutation: jest.fn((config: any) => config),
  internalMutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
  internalQuery: jest.fn((config: any) => config),
}));
jest.mock("convex/values", () => {
  const actualValues =
    jest.requireActual<typeof import("convex/values")>("convex/values");
  const validator = () => "validator";
  return {
    v: {
      id: validator,
      null: validator,
      string: validator,
      number: validator,
      optional: validator,
      object: validator,
      union: validator,
      array: validator,
      boolean: validator,
      literal: validator,
      any: validator,
      record: validator,
      int64: validator,
      float64: validator,
      bytes: validator,
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
const mockValidateServiceKey = jest.fn();
jest.mock("../lib/utils", () => ({
  validateServiceKey: (key: unknown) => mockValidateServiceKey(key),
}));
const mockAssertHistoryAccess = jest.fn<any>();
jest.mock("../lib/suspensionGuards", () => ({
  assertUserCanAccessChatHistory: (...args: unknown[]) =>
    mockAssertHistoryAccess(...args),
  isUserBlockedFromChatHistory: jest.fn<any>().mockResolvedValue(false),
  CHAT_ACCESS_SUSPENDED_CODE: "CHAT_ACCESS_SUSPENDED",
}));
const mockIsUserDeletionFenced = jest.fn<any>();
jest.mock("../lib/userDeletionFence", () => ({
  isUserDeletionFenced: (...args: unknown[]) =>
    mockIsUserDeletionFenced(...args),
}));
const mockInvalidateModelHistory = jest.fn<any>();
jest.mock("../modelHistory", () => ({
  invalidateModelHistory: (...args: unknown[]) =>
    mockInvalidateModelHistory(...args),
}));
jest.mock("../fileAggregate", () => ({
  fileCountAggregate: {
    deleteIfExists: jest.fn<any>().mockResolvedValue(undefined),
  },
}));
jest.mock("convex/server", () => ({
  paginationOptsValidator: "paginationOptsValidator",
}));

const CHAT_ID = "chat-001";
const OWNER = "user-owner";
const OTHER = "user-other";

type MessageDoc = {
  _id: string;
  id: string;
  chat_id: string;
  user_id?: string;
  role: "user" | "assistant";
  is_hidden?: boolean;
  _creationTime: number;
  file_ids?: string[];
  feedback_id?: string;
};

const message = (
  id: string,
  role: MessageDoc["role"],
  creationTime: number,
  extra: Partial<MessageDoc> = {},
): MessageDoc => ({
  _id: `doc-${id}`,
  id,
  chat_id: CHAT_ID,
  user_id: OWNER,
  role,
  _creationTime: creationTime,
  ...extra,
});

let messages: MessageDoc[];
let chat: Record<string, any> | null;
let ctx: any;

function createCtx(identitySubject: string | null = OWNER) {
  const deleted: string[] = [];
  const patches: Array<[string, Record<string, unknown>]> = [];
  ctx = {
    auth: {
      getUserIdentity: jest
        .fn<any>()
        .mockResolvedValue(
          identitySubject ? { subject: identitySubject } : null,
        ),
    },
    db: {
      query: jest.fn((table: string) => {
        if (table === "messages") {
          return {
            withIndex: () => ({
              order: () => ({
                async *[Symbol.asyncIterator]() {
                  yield* [...messages]
                    .filter((msg) => !deleted.includes(msg._id))
                    .sort((a, b) => b._creationTime - a._creationTime);
                },
              }),
            }),
          };
        }
        if (table === "chats") {
          return {
            withIndex: () => ({ first: async () => chat }),
          };
        }
        return {
          withIndex: () => ({
            first: async () => null,
            collect: async () => [],
          }),
        };
      }),
      get: jest.fn<any>().mockResolvedValue(null),
      patch: jest.fn(async (id: string, value: Record<string, unknown>) => {
        patches.push([id, value]);
      }),
      delete: jest.fn(async (id: string) => {
        deleted.push(id);
      }),
    },
    runQuery: jest.fn(async () => {
      if (!chat) throw new Error("CHAT_NOT_FOUND");
      if (chat.user_id !== (identitySubject ?? "")) {
        throw new Error("CHAT_UNAUTHORIZED");
      }
      return true;
    }),
    scheduler: { runAfter: jest.fn<any>().mockResolvedValue(undefined) },
  };
  return { deleted, patches };
}

const todos = [{ id: "t1", content: "Retest", status: "pending" as const }];

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockAssertHistoryAccess.mockResolvedValue(undefined);
  mockIsUserDeletionFenced.mockResolvedValue(false);
  mockInvalidateModelHistory.mockResolvedValue(undefined);
  messages = [
    message("u1", "user", 1),
    message("a1", "assistant", 2),
    message("u2", "user", 3),
    message("a2", "assistant", 4),
    message("a2-continued", "assistant", 5),
  ];
  chat = { _id: "chat-doc", id: CHAT_ID, user_id: OWNER };
});

describe("deleteRegenerateChainForBackend", () => {
  const run = async (args: Record<string, unknown> = {}) => {
    const { deleteRegenerateChainForBackend } = await import("../messages");
    return (deleteRegenerateChainForBackend as any).handler(ctx, {
      serviceKey: "service-key",
      chatId: CHAT_ID,
      userId: OWNER,
      expectedAssistantIds: ["a2", "a2-continued"],
      ...args,
    });
  };

  it("deletes exactly the replaced trailing chain and applies the cleaned todos", async () => {
    const { deleted, patches } = createCtx();

    await expect(run({ todos })).resolves.toBeNull();

    expect(mockValidateServiceKey).toHaveBeenCalledWith("service-key");
    expect(mockAssertHistoryAccess).toHaveBeenCalledWith(ctx, OWNER);
    expect(deleted.sort()).toEqual(["doc-a2", "doc-a2-continued"]);
    expect(mockInvalidateModelHistory).toHaveBeenCalledWith(ctx, CHAT_ID);
    expect(patches).toEqual([["chat-doc", { todos }]]);
  });

  it.each<[string, () => void, Record<string, unknown>]>([
    [
      "a newer answer saved after the client snapshot",
      () => messages.push(message("a3", "assistant", 6)),
      {},
    ],
    [
      "an expected chain missing one assistant",
      () => {},
      {
        expectedAssistantIds: ["a2"],
      },
    ],
    [
      "an expected ID that is not in the chain",
      () => {},
      {
        expectedAssistantIds: ["a2", "a2-continued", "a1"],
      },
    ],
    [
      "duplicate expected IDs",
      () => {},
      {
        expectedAssistantIds: ["a2", "a2"],
      },
    ],
    ["an empty expected chain", () => {}, { expectedAssistantIds: [] }],
    ["a blank expected ID", () => {}, { expectedAssistantIds: ["a2", " "] }],
    [
      "an expected ID longer than 128 characters",
      () => {},
      { expectedAssistantIds: ["a2", "x".repeat(129)] },
    ],
    [
      "a chain whose newest message belongs to another user",
      () => {
        messages[4] = { ...messages[4], user_id: OTHER };
      },
      {},
    ],
  ])("refuses %s without deleting anything", async (_, arrange, args) => {
    arrange();
    const { deleted, patches } = createCtx();

    await expect(run({ todos, ...args })).rejects.toMatchObject({
      data: { code: "REGENERATE_CHAIN_MISMATCH" },
    });
    expect(deleted).toEqual([]);
    expect(patches).toEqual([]);
    expect(mockInvalidateModelHistory).not.toHaveBeenCalled();
  });

  it("stops reading an over-long trailing chain at 1024 records and refuses before any write", async () => {
    const longTail = Array.from({ length: 1500 }, (_, i) =>
      message(`tail-${i}`, "assistant", 10 + i),
    );
    messages.push(...longTail);
    const { deleted, patches } = createCtx();
    let reads = 0;
    const query = ctx.db.query;
    ctx.db.query = jest.fn((table: string) => {
      const builder = query(table);
      if (table !== "messages") return builder;
      return {
        withIndex: () => ({
          order: () => ({
            async *[Symbol.asyncIterator]() {
              for await (const msg of builder.withIndex().order()) {
                reads++;
                yield msg;
              }
            },
          }),
        }),
      };
    });

    await expect(
      run({
        todos,
        expectedAssistantIds: longTail.slice(0, 256).map((msg) => msg.id),
      }),
    ).rejects.toMatchObject({
      data: { code: "REGENERATE_CHAIN_MISMATCH" },
    });
    expect(reads).toBe(1025);
    expect(deleted).toEqual([]);
    expect(patches).toEqual([]);
    expect(mockInvalidateModelHistory).not.toHaveBeenCalled();
  });

  it("refuses another user's chat before reading its messages", async () => {
    chat = { _id: "chat-doc", id: CHAT_ID, user_id: OTHER };
    const { deleted } = createCtx();

    await expect(run()).rejects.toMatchObject({
      data: { code: "CHAT_UNAUTHORIZED" },
    });
    expect(deleted).toEqual([]);
    expect(ctx.db.query).not.toHaveBeenCalledWith("messages");
  });

  it.each<[string, () => void, string]>([
    ["a missing chat", () => (chat = null), "CHAT_NOT_FOUND"],
    [
      "a chat being deleted",
      () => (chat = { ...chat, deletion_started_at: 1 }),
      "CHAT_NOT_FOUND",
    ],
    [
      "a user being deleted",
      () => mockIsUserDeletionFenced.mockResolvedValue(true),
      "CHAT_NOT_FOUND",
    ],
    [
      "suspended chat history access",
      () =>
        mockAssertHistoryAccess.mockRejectedValue(
          Object.assign(new Error("suspended"), {
            data: { code: "CHAT_ACCESS_SUSPENDED" },
          }),
        ),
      "CHAT_ACCESS_SUSPENDED",
    ],
  ])("refuses %s without deleting", async (_, arrange, code) => {
    arrange();
    const { deleted } = createCtx();
    await expect(run()).rejects.toMatchObject({ data: { code } });
    expect(deleted).toEqual([]);
  });

  it("rejects an invalid service key before touching data", async () => {
    mockValidateServiceKey.mockImplementationOnce(() => {
      throw new Error("Unauthorized: Invalid service key");
    });
    const { deleted } = createCtx();
    await expect(run()).rejects.toThrow("Invalid service key");
    expect(ctx.db.query).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });
});

describe("deleteLastAssistantMessage (existing public path, shared deletion)", () => {
  const run = async (args: Record<string, unknown> = {}) => {
    const { deleteLastAssistantMessage } = await import("../messages");
    return (deleteLastAssistantMessage as any).handler(ctx, {
      chatId: CHAT_ID,
      ...args,
    });
  };

  it("still deletes the whole trailing chain, including hidden continuations, for the signed-in owner", async () => {
    messages.splice(
      4,
      0,
      message("hidden-continue", "user", 4.5, { is_hidden: true }),
    );
    const { deleted, patches } = createCtx();

    await expect(run({ todos })).resolves.toBeNull();

    expect(deleted.sort()).toEqual([
      "doc-a2",
      "doc-a2-continued",
      "doc-hidden-continue",
    ]);
    expect(patches).toEqual([["chat-doc", { todos }]]);
  });

  it("does not delete another user's chain", async () => {
    const { deleted } = createCtx(OTHER);
    await expect(run()).rejects.toThrow("Unauthorized");
    expect(deleted).toEqual([]);
  });
});
