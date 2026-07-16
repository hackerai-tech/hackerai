import { beforeEach, describe, expect, it, jest } from "@jest/globals";

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
    data: unknown;
    constructor(data: unknown) {
      super("Convex error");
      this.data = data;
    }
  },
}));

jest.mock("convex/server", () => ({
  paginationOptsValidator: "paginationOptsValidator",
}));

jest.mock("../_generated/api", () => ({
  internal: { chats: {}, redisPubsub: {}, s3Cleanup: {} },
}));

jest.mock("../fileAggregate", () => ({
  fileCountAggregate: {
    deleteIfExists: jest.fn<any>().mockResolvedValue(undefined),
  },
}));

const mockValidateServiceKey = jest.fn();
jest.mock("../lib/utils", () => ({
  validateServiceKey: (...args: unknown[]) => mockValidateServiceKey(...args),
}));

jest.mock("../lib/suspensionGuards", () => ({
  CHAT_ACCESS_SUSPENDED_CODE: "CHAT_ACCESS_SUSPENDED",
  assertUserCanAccessChatHistory: jest.fn<any>().mockResolvedValue(undefined),
}));

const {
  deleteChatForBackend,
  fenceChatsForDeletion,
  getActiveTriggerRunsForUser,
  setActiveTriggerRun,
} = require("../chats") as typeof import("../chats");

const makeCtx = (chat: Record<string, unknown> | null) => {
  const first = jest.fn<any>().mockResolvedValue(chat);
  const withIndex = jest.fn(() => ({ first }));
  const query = jest.fn(() => ({ withIndex }));
  const patch = jest.fn<any>().mockResolvedValue(undefined);
  return { ctx: { db: { query, patch } } as any, patch };
};

describe("Agent approval lifecycle guards", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("refuses deletion when the active run/session snapshot changed", async () => {
    const { ctx, patch } = makeCtx({
      _id: "chat-doc-1",
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: "run-2",
      active_agent_approval_session_id: "approval-session-2",
    });

    await expect(
      deleteChatForBackend.handler(ctx, {
        serviceKey: "service-key",
        chatId: "chat-1",
        userId: "user-1",
        expectedTriggerRunId: "run-1",
        expectedApprovalSessionId: "approval-session-1",
      }),
    ).resolves.toBe("stale");
    expect(patch).not.toHaveBeenCalled();
  });

  it("cascades structured findings before deleting their source chat", async () => {
    const tables: Record<string, Array<Record<string, any>>> = {
      chats: [
        {
          _id: "chat-doc-1",
          id: "chat-1",
          user_id: "user-1",
          canceled_at: 1,
        },
      ],
      findings: [
        {
          _id: "finding-doc-1",
          user_id: "user-1",
          chat_id: "chat-1",
          created_at: 1,
        },
      ],
      messages: [],
      chat_summaries: [],
    };
    const deleted: string[] = [];
    const db = {
      query: jest.fn((table: string) => ({
        withIndex: jest.fn((_index: string, build: (q: any) => any) => {
          const filters: Array<[string, unknown]> = [];
          const q: any = {
            eq: (field: string, value: unknown) => {
              filters.push([field, value]);
              return q;
            },
          };
          build(q);
          const rows = () =>
            (tables[table] ?? []).filter((row) =>
              filters.every(([field, value]) => row[field] === value),
            );
          return {
            first: jest.fn(async () => rows()[0] ?? null),
            take: jest.fn(async (limit: number) => rows().slice(0, limit)),
          };
        }),
      })),
      patch: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn(async (id: string) => {
        deleted.push(id);
        for (const [table, rows] of Object.entries(tables)) {
          tables[table] = rows.filter((row) => row._id !== id);
        }
      }),
    };

    await expect(
      deleteChatForBackend.handler(
        { db, scheduler: { runAfter: jest.fn() } } as any,
        {
          serviceKey: "service-key",
          chatId: "chat-1",
          userId: "user-1",
          expectedTriggerRunId: null,
          expectedApprovalSessionId: null,
        },
      ),
    ).resolves.toBe("deleted");

    expect(deleted).toEqual(["finding-doc-1", "chat-doc-1"]);
  });

  it("does not attach a new run after chat deletion starts", async () => {
    const { ctx, patch } = makeCtx({
      _id: "chat-doc-1",
      id: "chat-1",
      user_id: "user-1",
      deletion_started_at: Date.now(),
    });

    await expect(
      setActiveTriggerRun.handler(ctx, {
        serviceKey: "service-key",
        chatId: "chat-1",
        triggerRunId: "late-run",
        approvalSessionId: "late-approval-session",
      }),
    ).resolves.toBe("deleting");
    expect(patch).not.toHaveBeenCalled();
  });

  it("fences an inactive chat before a late run can be associated", async () => {
    const chat: Record<string, unknown> = {
      _id: "chat-doc-1",
      id: "chat-1",
      user_id: "user-1",
    };
    const paginate = jest.fn<any>().mockResolvedValue({
      page: [chat],
      isDone: true,
      continueCursor: "",
    });
    const first = jest.fn<any>().mockImplementation(async () => chat);
    const withIndex = jest.fn((indexName: string) =>
      indexName === "by_user_and_updated" ? { paginate } : { first },
    );
    const patch = jest.fn<any>().mockImplementation(async (_id, update) => {
      Object.assign(chat, update);
    });
    const ctx = {
      db: { query: jest.fn(() => ({ withIndex })), patch },
    } as any;

    await expect(
      fenceChatsForDeletion.handler(ctx, {
        serviceKey: "service-key",
        userId: "user-1",
        cursor: null,
      }),
    ).resolves.toEqual({
      fencedChats: 1,
      isDone: true,
      continueCursor: "",
      resources: [],
    });
    await expect(
      setActiveTriggerRun.handler(ctx, {
        serviceKey: "service-key",
        chatId: "chat-1",
        triggerRunId: "late-run",
        approvalSessionId: "late-approval-session",
      }),
    ).resolves.toBe("deleting");
    expect(chat.deletion_started_at).toEqual(expect.any(Number));
    expect(chat.active_trigger_run_id).toBeUndefined();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(paginate).toHaveBeenCalledWith({ cursor: null, numItems: 100 });
  });

  it("reports when a started run has no chat row to associate with", async () => {
    const { ctx, patch } = makeCtx(null);

    await expect(
      setActiveTriggerRun.handler(ctx, {
        serviceKey: "service-key",
        chatId: "deleted-chat",
        triggerRunId: "late-run",
      }),
    ).resolves.toBe("not_found");
    expect(patch).not.toHaveBeenCalled();
  });

  it("reports successful active-run association", async () => {
    const { ctx, patch } = makeCtx({
      _id: "chat-doc-1",
      id: "chat-1",
      user_id: "user-1",
    });

    await expect(
      setActiveTriggerRun.handler(ctx, {
        serviceKey: "service-key",
        chatId: "chat-1",
        triggerRunId: "run-1",
        approvalSessionId: "approval-session-1",
      }),
    ).resolves.toBe("updated");
    expect(patch).toHaveBeenCalledWith(
      "chat-doc-1",
      expect.objectContaining({
        active_trigger_run_id: "run-1",
        active_agent_approval_session_id: "approval-session-1",
      }),
    );
  });

  it("replaces an ordinary stream cancellation with a new Agent run", async () => {
    const { ctx, patch } = makeCtx({
      _id: "chat-doc-1",
      id: "chat-1",
      user_id: "user-1",
      canceled_at: Date.now(),
    });

    await expect(
      setActiveTriggerRun.handler(ctx, {
        serviceKey: "service-key",
        chatId: "chat-1",
        triggerRunId: "replacement-run",
        approvalSessionId: "replacement-session",
      }),
    ).resolves.toBe("updated");
    expect(patch).toHaveBeenCalledWith(
      "chat-doc-1",
      expect.objectContaining({
        active_trigger_run_id: "replacement-run",
        active_agent_approval_session_id: "replacement-session",
        canceled_at: undefined,
      }),
    );
  });

  it("returns the approval session paired with each active Trigger run", async () => {
    const take = jest.fn<any>().mockResolvedValue([
      {
        id: "chat-1",
        active_trigger_run_id: "run-1",
        active_agent_approval_session_id: "approval-session-1",
      },
    ]);
    const withIndex = jest.fn(
      (_name: string, build: (q: Record<string, jest.Mock>) => unknown) => {
        const q: Record<string, jest.Mock> = {};
        q.eq = jest.fn(() => q);
        q.gt = jest.fn(() => q);
        build(q);
        return { take };
      },
    );
    const ctx = { db: { query: jest.fn(() => ({ withIndex })) } } as any;

    await expect(
      getActiveTriggerRunsForUser.handler(ctx, {
        serviceKey: "service-key",
        userId: "user-1",
      }),
    ).resolves.toEqual({
      runs: [
        {
          chatId: "chat-1",
          triggerRunId: "run-1",
          approvalSessionId: "approval-session-1",
        },
      ],
      hasMore: false,
    });
  });

  it("returns approval Sessions even when no Trigger run is stored", async () => {
    const chat = {
      _id: "chat-doc-1",
      id: "chat-1",
      user_id: "user-1",
      active_agent_approval_session_id: "approval-session-1",
    };
    const paginate = jest.fn<any>().mockResolvedValue({
      page: [chat],
      isDone: true,
      continueCursor: "",
    });
    const withIndex = jest.fn(() => ({ paginate }));
    const patch = jest.fn<any>().mockResolvedValue(undefined);
    const ctx = {
      db: { query: jest.fn(() => ({ withIndex })), patch },
    } as any;

    await expect(
      fenceChatsForDeletion.handler(ctx, {
        serviceKey: "service-key",
        userId: "user-1",
        cursor: null,
      }),
    ).resolves.toEqual({
      fencedChats: 1,
      isDone: true,
      continueCursor: "",
      resources: [
        {
          chatId: "chat-1",
          approvalSessionId: "approval-session-1",
        },
      ],
    });
    expect(patch).toHaveBeenCalledWith("chat-doc-1", {
      deletion_started_at: expect.any(Number),
    });
  });
});
