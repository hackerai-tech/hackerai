import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * Exercises the real regeneration handlers against an in-memory message/chat
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
  const live = () => messages.filter((msg) => !deleted.includes(msg._id));
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
            withIndex: (
              index: string,
              build?: (q: {
                eq: (field: string, value: string) => unknown;
              }) => unknown,
            ) => {
              let value: string | undefined;
              const q = {
                eq: (_field: string, v: string) => {
                  value = v;
                  return q;
                },
              };
              build?.(q);
              return {
                // by_message_id lookup
                first: async () =>
                  index === "by_message_id"
                    ? (live().find((msg) => msg.id === value) ?? null)
                    : null,
                // by_chat_id newest-first walk
                order: () => ({
                  async *[Symbol.asyncIterator]() {
                    yield* live().sort(
                      (a, b) => b._creationTime - a._creationTime,
                    );
                  },
                }),
              };
            },
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
      get: jest.fn(async (id: string) =>
        String(id).startsWith("file-") ? { _id: id } : null,
      ),
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

/** Wrap the newest-first walk to count how many records a handler reads. */
function countChainReads() {
  const counter = { reads: 0 };
  const query = ctx.db.query;
  ctx.db.query = jest.fn((table: string) => {
    const builder = query(table);
    if (table !== "messages") return builder;
    return {
      withIndex: (index: string, build?: any) => {
        const inner = builder.withIndex(index, build);
        return {
          ...inner,
          order: () => ({
            async *[Symbol.asyncIterator]() {
              for await (const msg of inner.order()) {
                counter.reads++;
                yield msg;
              }
            },
          }),
        };
      },
    };
  });
  return counter;
}

const todos = [{ id: "t1", content: "Retest", status: "pending" as const }];
const OLD_IDS = ["a2", "a2-continued"];

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
    message("a2", "assistant", 4, { file_ids: ["file-old"] }),
    message("a2-continued", "assistant", 5),
  ];
  chat = { _id: "chat-doc", id: CHAT_ID, user_id: OWNER };
});

/** Shared fence cases: both phases refuse these without writing. */
const accessRefusals: Array<[string, () => void, string]> = [
  ["a missing chat", () => (chat = null), "CHAT_NOT_FOUND"],
  [
    "another user's chat",
    () => (chat = { _id: "chat-doc", id: CHAT_ID, user_id: OTHER }),
    "CHAT_UNAUTHORIZED",
  ],
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
];

describe("validateRegenerateChainForBackend (read-only, before the provider)", () => {
  const run = async (args: Record<string, unknown> = {}) => {
    const { validateRegenerateChainForBackend } = await import("../messages");
    return (validateRegenerateChainForBackend as any).handler(ctx, {
      serviceKey: "service-key",
      chatId: CHAT_ID,
      userId: OWNER,
      expectedAssistantIds: OLD_IDS,
      ...args,
    });
  };

  it("accepts the exact owned chain and changes nothing", async () => {
    const { deleted, patches } = createCtx();

    await expect(run()).resolves.toBeNull();

    expect(mockValidateServiceKey).toHaveBeenCalledWith("service-key");
    expect(mockAssertHistoryAccess).toHaveBeenCalledWith(ctx, OWNER);
    expect(deleted).toEqual([]);
    expect(patches).toEqual([]);
    expect(ctx.db.delete).not.toHaveBeenCalled();
    expect(ctx.db.patch).not.toHaveBeenCalled();
    expect(mockInvalidateModelHistory).not.toHaveBeenCalled();
  });

  it.each<[string, () => void, Record<string, unknown>]>([
    [
      "a newer answer saved after the client snapshot",
      () => messages.push(message("a3", "assistant", 6)),
      {},
    ],
    [
      "a missing expected assistant",
      () => {},
      { expectedAssistantIds: ["a2"] },
    ],
    [
      "an extra expected ID",
      () => {},
      { expectedAssistantIds: [...OLD_IDS, "a1"] },
    ],
    ["duplicate IDs", () => {}, { expectedAssistantIds: ["a2", "a2"] }],
    ["an empty chain", () => {}, { expectedAssistantIds: [] }],
    ["a blank ID", () => {}, { expectedAssistantIds: ["a2", " "] }],
    [
      "an ID over 128 characters",
      () => {},
      { expectedAssistantIds: ["a2", "x".repeat(129)] },
    ],
    [
      "a chain message owned by another user",
      () => {
        messages[4] = { ...messages[4], user_id: OTHER };
      },
      {},
    ],
  ])("refuses %s", async (_, arrange, args) => {
    arrange();
    createCtx();
    await expect(run(args)).rejects.toMatchObject({
      data: { code: "REGENERATE_CHAIN_MISMATCH" },
    });
    expect(ctx.db.delete).not.toHaveBeenCalled();
  });

  it("stops reading an over-long chain at 1024 records", async () => {
    const longTail = Array.from({ length: 1500 }, (_, i) =>
      message(`tail-${i}`, "assistant", 10 + i),
    );
    messages.push(...longTail);
    createCtx();
    const counter = countChainReads();

    await expect(
      run({ expectedAssistantIds: longTail.slice(0, 256).map((m) => m.id) }),
    ).rejects.toMatchObject({ data: { code: "REGENERATE_CHAIN_MISMATCH" } });
    expect(counter.reads).toBe(1025);
  });

  it.each(accessRefusals)("refuses %s", async (_, arrange, code) => {
    arrange();
    createCtx();
    await expect(run()).rejects.toMatchObject({ data: { code } });
    expect(ctx.db.delete).not.toHaveBeenCalled();
  });

  it("rejects an invalid service key before reading data", async () => {
    mockValidateServiceKey.mockImplementationOnce(() => {
      throw new Error("Unauthorized: Invalid service key");
    });
    createCtx();
    await expect(run()).rejects.toThrow("Invalid service key");
    expect(ctx.db.query).not.toHaveBeenCalled();
  });
});

describe("deleteRegenerateChainForBackend (commit after the replacement is saved)", () => {
  const run = async (args: Record<string, unknown> = {}) => {
    const { deleteRegenerateChainForBackend } = await import("../messages");
    return (deleteRegenerateChainForBackend as any).handler(ctx, {
      serviceKey: "service-key",
      chatId: CHAT_ID,
      userId: OWNER,
      expectedAssistantIds: OLD_IDS,
      replacementAssistantId: "r1",
      resetSummary: true,
      todos,
      ...args,
    });
  };
  const saveReplacement = (extra: Partial<MessageDoc> = {}) =>
    messages.push(
      message("r1", "assistant", 6, { file_ids: ["file-new"], ...extra }),
    );

  it("removes only the old chain and its files; the saved replacement and its files remain", async () => {
    messages.splice(
      4,
      0,
      message("hidden-continue", "user", 4.5, { is_hidden: true }),
    );
    saveReplacement();
    const { deleted, patches } = createCtx();

    await expect(run()).resolves.toBeNull();

    expect(deleted.sort()).toEqual([
      "doc-a2",
      "doc-a2-continued",
      "doc-hidden-continue",
      "file-old",
    ]);
    expect(deleted).not.toContain("doc-r1");
    expect(deleted).not.toContain("file-new");
    expect(mockInvalidateModelHistory).toHaveBeenCalledWith(ctx, CHAT_ID);
    // resetSummary clears summaries, matching the client regenerate intent.
    expect(ctx.db.query).toHaveBeenCalledWith("chat_summaries");
    // The run's final merged todos.
    expect(patches).toEqual([["chat-doc", { todos }]]);
  });

  it("is an idempotent no-op once the old chain is gone and the replacement is the tail", async () => {
    saveReplacement();
    const first = createCtx();
    await run();
    expect(first.deleted).toContain("doc-a2");
    messages = messages.filter((msg) => !first.deleted.includes(msg._id));

    const second = createCtx();
    await expect(run()).resolves.toBeNull();
    expect(second.deleted).toEqual([]);
    expect(second.patches).toEqual([]);
  });

  describe("successful provider retry (server-supplied superseded primary attempt)", () => {
    const withS3Files = () => {
      ctx.db.get = jest.fn(async (id: string) =>
        String(id).startsWith("file-") ? { _id: id, s3_key: `s3/${id}` } : null,
      );
    };
    const scheduledS3Keys = () =>
      ctx.scheduler.runAfter.mock.calls.map(
        (call: unknown[]) => (call[2] as { s3Key: string }).s3Key,
      );

    it("deletes the old chain and the superseded attempt; the new reply and every file it shares remain", async () => {
      messages.push(
        message("primary", "assistant", 5.5, {
          file_ids: ["file-shared", "file-primary-only"],
        }),
      );
      messages.push(
        message("r1", "assistant", 6, {
          file_ids: ["file-shared", "file-new"],
          feedback_id: "feedback-new",
        }),
      );
      // An old row can also reference an artifact the new reply kept.
      messages[3] = { ...messages[3], file_ids: ["file-old", "file-shared"] };
      const { deleted } = createCtx();
      withS3Files();

      await expect(
        run({ supersededAssistantId: "primary" }),
      ).resolves.toBeNull();

      expect(deleted.sort()).toEqual([
        "doc-a2",
        "doc-a2-continued",
        "doc-primary",
        "file-old",
        "file-primary-only",
      ]);
      for (const kept of ["doc-r1", "file-shared", "file-new", "feedback-new"])
        expect(deleted).not.toContain(kept);
      expect(scheduledS3Keys().sort()).toEqual([
        "s3/file-old",
        "s3/file-primary-only",
      ]);
    });

    it("succeeds when the superseded attempt was never saved", async () => {
      saveReplacement();
      const { deleted } = createCtx();

      await expect(
        run({ supersededAssistantId: "primary" }),
      ).resolves.toBeNull();
      expect(deleted.sort()).toEqual([
        "doc-a2",
        "doc-a2-continued",
        "file-old",
      ]);
    });

    it("still refuses an unknown assistant alongside the superseded attempt", async () => {
      messages.push(message("primary", "assistant", 5.5));
      messages.push(message("unknown", "assistant", 5.7));
      saveReplacement();
      const { deleted, patches } = createCtx();

      await expect(
        run({ supersededAssistantId: "primary" }),
      ).rejects.toMatchObject({ data: { code: "REGENERATE_CHAIN_MISMATCH" } });
      expect(deleted).toEqual([]);
      expect(patches).toEqual([]);
    });

    it("refuses an unannounced earlier attempt (primary success passes none)", async () => {
      messages.push(message("primary", "assistant", 5.5));
      saveReplacement();
      const { deleted } = createCtx();

      await expect(run()).rejects.toMatchObject({
        data: { code: "REGENERATE_CHAIN_MISMATCH" },
      });
      expect(deleted).toEqual([]);
    });

    it.each<[string, string]>([
      ["blank", " "],
      ["over 128 characters", "x".repeat(129)],
      ["the replacement itself", "r1"],
      ["an expected old ID", "a2"],
    ])(
      "rejects a superseded ID that is %s before any write",
      async (_, supersededAssistantId) => {
        saveReplacement();
        const { deleted } = createCtx();

        await expect(run({ supersededAssistantId })).rejects.toMatchObject({
          data: { code: "REGENERATE_CHAIN_MISMATCH" },
        });
        expect(deleted).toEqual([]);
        expect(ctx.db.query).not.toHaveBeenCalledWith("messages");
      },
    );
  });

  it.each<[string, () => void, Record<string, unknown>]>([
    ["a replacement that was never saved", () => {}, {}],
    [
      "a replacement that is not the newest saved answer",
      () => {
        saveReplacement();
        messages.push(message("newer", "assistant", 7));
      },
      {},
    ],
    [
      "a replacement saved by another user",
      () => saveReplacement({ user_id: OTHER }),
      {},
    ],
    [
      "an old chain that changed (extra assistant)",
      () => {
        messages.push(message("intermediate", "assistant", 5.5));
        saveReplacement();
      },
      {},
    ],
    [
      "an expected chain missing one assistant",
      () => saveReplacement(),
      { expectedAssistantIds: ["a2"] },
    ],
    [
      "an old chain message owned by another user",
      () => {
        messages[4] = { ...messages[4], user_id: OTHER };
        saveReplacement();
      },
      {},
    ],
    [
      "a replacement ID that is also an old ID",
      () => saveReplacement(),
      { replacementAssistantId: "a2" },
    ],
    [
      "a no-op claim while an old ID is still saved elsewhere",
      () => {
        // Old chain no longer trailing (a visible user turn intervened), but
        // its IDs still exist: not an already-completed commit.
        messages.push(message("u3", "user", 5.5));
        saveReplacement();
      },
      {},
    ],
  ])("preserves everything for %s", async (_, arrange, args) => {
    arrange();
    const { deleted, patches } = createCtx();

    await expect(run(args)).rejects.toMatchObject({
      data: { code: "REGENERATE_CHAIN_MISMATCH" },
    });
    expect(deleted).toEqual([]);
    expect(patches).toEqual([]);
    expect(mockInvalidateModelHistory).not.toHaveBeenCalled();
  });

  it("reads at most the bound plus the replacement for an over-long chain, writing nothing", async () => {
    const longTail = Array.from({ length: 1500 }, (_, i) =>
      message(`tail-${i}`, "assistant", 10 + i),
    );
    messages.push(...longTail);
    messages.push(message("r1", "assistant", 5000));
    const { deleted } = createCtx();
    const counter = countChainReads();

    await expect(
      run({ expectedAssistantIds: longTail.slice(0, 256).map((m) => m.id) }),
    ).rejects.toMatchObject({ data: { code: "REGENERATE_CHAIN_MISMATCH" } });
    expect(counter.reads).toBe(1026);
    expect(deleted).toEqual([]);
  });

  it.each(accessRefusals)(
    "refuses %s without deleting",
    async (_, arrange, code) => {
      saveReplacement();
      arrange();
      const { deleted } = createCtx();
      await expect(run()).rejects.toMatchObject({ data: { code } });
      expect(deleted).toEqual([]);
    },
  );

  it("rejects an invalid service key before touching data", async () => {
    saveReplacement();
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
      "file-old",
    ]);
    expect(patches).toEqual([["chat-doc", { todos }]]);
  });

  it("does not delete another user's chain", async () => {
    const { deleted } = createCtx(OTHER);
    await expect(run()).rejects.toThrow("Unauthorized");
    expect(deleted).toEqual([]);
  });
});
