import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockValidateUserResearchServiceKey = jest.fn();

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config) => config),
  query: jest.fn((config) => config),
}));

jest.mock("convex/values", () => ({
  ConvexError: class ConvexError extends Error {},
  v: new Proxy(
    {},
    {
      get: () => jest.fn(() => "validator"),
    },
  ),
}));

jest.mock("../lib/userResearchAuth", () => ({
  validateUserResearchServiceKey: mockValidateUserResearchServiceKey,
}));

type Row = { _id: string; _creationTime?: number; [key: string]: unknown };

const createCtx = (args: {
  messageCount: number;
  runStatus?: "queued" | "running" | "completed" | "failed";
  samplingMode?: "representative" | "pre_event";
  evidenceWindowDays?: number;
  evidenceAnchorAt?: number;
  chatUpdateTimes?: number[];
  memberUserId?: string;
}) => {
  const userId = "user-1";
  const chatId = "chat-1";
  const tables: Record<string, Row[]> = {
    research_runs: [
      {
        _id: "run-1",
        analysis_id: "analysis-1",
        status: args.runStatus ?? "running",
        ...(args.samplingMode ? { sampling_mode: args.samplingMode } : {}),
        ...(args.evidenceWindowDays
          ? { evidence_window_days: args.evidenceWindowDays }
          : {}),
      },
    ],
    research_run_members: [
      {
        _id: "member-1",
        analysis_id: "analysis-1",
        user_id: args.memberUserId ?? userId,
        pseudonym: "U01",
        ...(args.evidenceAnchorAt
          ? { evidence_anchor_at: args.evidenceAnchorAt }
          : {}),
      },
    ],
    chats: (args.chatUpdateTimes ?? [1]).map((updateTime, index) => ({
      _id: `chat-doc-${index + 1}`,
      id: index === 0 ? chatId : `chat-${index + 1}`,
      user_id: userId,
      update_time: updateTime,
    })),
    messages: Array.from({ length: args.messageCount }, (_, index) => ({
      _id: `message-${index + 1}`,
      _creationTime: index + 1,
      chat_id: chatId,
      role: index % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `message ${index + 1}` }],
    })),
  };

  const db = {
    query: jest.fn((table: string) => ({
      withIndex: jest.fn(
        (_index: string, build: (q: Record<string, unknown>) => unknown) => {
          const filters: Array<{
            field: string;
            operator: "eq" | "gte" | "lte";
            value: unknown;
          }> = [];
          const q = {
            eq: (field: string, value: unknown) => {
              filters.push({ field, operator: "eq", value });
              return q;
            },
            gte: (field: string, value: unknown) => {
              filters.push({ field, operator: "gte", value });
              return q;
            },
            lte: (field: string, value: unknown) => {
              filters.push({ field, operator: "lte", value });
              return q;
            },
          };
          build(q);
          const rows = (tables[table] ?? []).filter((row) =>
            filters.every(({ field, operator, value }) => {
              if (operator === "eq") return row[field] === value;
              if (typeof row[field] !== "number" || typeof value !== "number") {
                return false;
              }
              return operator === "gte"
                ? row[field] >= value
                : row[field] <= value;
            }),
          );
          const ordered = (direction: "asc" | "desc") => {
            const sorted = [...rows].sort(
              (a, b) =>
                (((table === "chats" ? a.update_time : a._creationTime) as
                  number | undefined) ?? 0) -
                (((table === "chats" ? b.update_time : b._creationTime) as
                  number | undefined) ?? 0),
            );
            return direction === "desc" ? sorted.reverse() : sorted;
          };
          return {
            unique: jest.fn(async () => rows[0] ?? null),
            take: jest.fn(async (limit: number) => rows.slice(0, limit)),
            order: jest.fn((direction: "asc" | "desc") => ({
              first: jest.fn(async () => ordered(direction)[0] ?? null),
              take: jest.fn(async (limit: number) =>
                ordered(direction).slice(0, limit),
              ),
            })),
          };
        },
      ),
    })),
  };
  return { ctx: { db }, userId, chatId };
};

describe("userResearch.getMessageExcerpt", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("requires an active audited run containing the user", async () => {
    const { getMessageExcerpt } = await import("../userResearch");
    const { ctx, userId, chatId } = createCtx({
      messageCount: 20,
      memberUserId: "someone-else",
    });

    await expect(
      getMessageExcerpt.handler(ctx as never, {
        serviceKey: "service-key",
        analysisId: "analysis-1",
        userId,
        chatId,
        maxMessages: 20,
      }),
    ).rejects.toThrow("User is not part of this research run");
    expect(mockValidateUserResearchServiceKey).toHaveBeenCalledWith(
      "service-key",
    );
  });

  it.each(["queued", "completed", "failed"] as const)(
    "rejects a %s research run",
    async (runStatus) => {
      const { getMessageExcerpt } = await import("../userResearch");
      const { ctx, userId, chatId } = createCtx({
        messageCount: 20,
        runStatus,
      });

      await expect(
        getMessageExcerpt.handler(ctx as never, {
          serviceKey: "service-key",
          analysisId: "analysis-1",
          userId,
          chatId,
          maxMessages: 20,
        }),
      ).rejects.toThrow("Research run is not active");
    },
  );

  it("does not mark a chat truncated at the exact message limit", async () => {
    const { getMessageExcerpt } = await import("../userResearch");
    const { ctx, userId, chatId } = createCtx({ messageCount: 20 });

    const result = await getMessageExcerpt.handler(ctx as never, {
      serviceKey: "service-key",
      analysisId: "analysis-1",
      userId,
      chatId,
      maxMessages: 20,
    });

    expect(result.messages).toHaveLength(20);
    expect(result.truncated).toBe(false);
  });

  it("marks a chat truncated when messages exist beyond both excerpts", async () => {
    const { getMessageExcerpt } = await import("../userResearch");
    const { ctx, userId, chatId } = createCtx({ messageCount: 21 });

    const result = await getMessageExcerpt.handler(ctx as never, {
      serviceKey: "service-key",
      analysisId: "analysis-1",
      userId,
      chatId,
      maxMessages: 20,
    });

    expect(result.messages).toHaveLength(20);
    expect(result.truncated).toBe(true);
  });
});

describe("userResearch.listRepresentativeChats", () => {
  it("limits churn evidence to the configured pre-event window", async () => {
    const { listRepresentativeChats } = await import("../userResearch");
    const anchorAt = Date.UTC(2026, 7, 25);
    const day = 24 * 60 * 60 * 1_000;
    const { ctx, userId } = createCtx({
      messageCount: 0,
      samplingMode: "pre_event",
      evidenceWindowDays: 60,
      evidenceAnchorAt: anchorAt,
      chatUpdateTimes: [
        anchorAt - 70 * day,
        anchorAt - 40 * day,
        anchorAt - 10 * day,
        anchorAt + day,
      ],
    });

    const result = await listRepresentativeChats.handler(ctx as never, {
      serviceKey: "service-key",
      analysisId: "analysis-1",
      userId,
      maxChats: 3,
    });

    expect(result.map((chat) => chat.updatedAt)).toEqual([
      anchorAt - 40 * day,
      anchorAt - 10 * day,
    ]);
  });
});

describe("userResearch.createRun", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("creates an auditable run without optional Linear tracking", async () => {
    const insert = jest.fn(async () => "document-id");
    const ctx = {
      db: {
        query: jest.fn(() => ({
          withIndex: jest.fn(() => ({
            unique: jest.fn(async () => null),
          })),
        })),
        insert,
      },
    };
    const { createRun } = await import("../userResearch");

    await createRun.handler(ctx as never, {
      serviceKey: "service-key",
      analysisId: "analysis-1",
      question: "What recurring work creates the most customer value?",
      cohortLabel: "Approved production research cohort",
      requestedBy: "pm-gateway",
      cohortSource: "posthog",
      posthogProjectId: 144137,
      cohortSelectedAt: Date.UTC(2026, 7, 25),
      selectionQueryFingerprint:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      selectionLimitations: ["Historical revenue is incomplete"],
      samplingMode: "representative",
      members: [
        { userId: "user-1", pseudonym: "U01" },
        { userId: "user-2", pseudonym: "U02" },
        { userId: "user-3", pseudonym: "U03" },
      ],
      maxChatsPerUser: 12,
      model: "x-ai/grok-4.6",
      reasoningEnabled: true,
      reasoningEffort: "low",
    });

    expect(insert).toHaveBeenCalledWith(
      "research_runs",
      expect.objectContaining({
        cohort_source: "posthog",
        posthog_project_id: 144137,
        reasoning_enabled: true,
        reasoning_effort: "low",
        sampling_mode: "representative",
      }),
    );
    expect(insert).toHaveBeenCalledWith(
      "research_runs",
      expect.not.objectContaining({ linear_issue_id: expect.anything() }),
    );
    expect(insert).toHaveBeenCalledTimes(4);
  });

  it("rejects pre-event runs without a per-user evidence anchor", async () => {
    const { createRun } = await import("../userResearch");

    await expect(
      createRun.handler({ db: {} } as never, {
        serviceKey: "service-key",
        analysisId: "analysis-1",
        question: "What friction appeared before these users cancelled?",
        cohortLabel: "Recent paid cancellation cohort",
        requestedBy: "pm-gateway",
        cohortSource: "posthog",
        posthogProjectId: 144137,
        cohortSelectedAt: Date.UTC(2026, 7, 25),
        selectionQueryFingerprint:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        selectionLimitations: [],
        samplingMode: "pre_event",
        evidenceWindowDays: 60,
        members: [
          { userId: "user-1", pseudonym: "U01" },
          { userId: "user-2", pseudonym: "U02" },
          { userId: "user-3", pseudonym: "U03" },
        ],
        maxChatsPerUser: 12,
        model: "x-ai/grok-4.6",
        reasoningEnabled: true,
        reasoningEffort: "low",
      }),
    ).rejects.toThrow("Every pre_event member requires");
  });
});

describe("userResearch.failRun", () => {
  it("does not overwrite a completed terminal state", async () => {
    const patch = jest.fn();
    const { ctx } = createCtx({ messageCount: 0, runStatus: "completed" });
    (ctx.db as typeof ctx.db & { patch: typeof patch }).patch = patch;
    const { failRun } = await import("../userResearch");

    await failRun.handler(ctx as never, {
      serviceKey: "service-key",
      analysisId: "analysis-1",
      error: "late worker error",
    });

    expect(patch).not.toHaveBeenCalled();
  });

  it("records failure only while a run is active", async () => {
    const patch = jest.fn();
    const { ctx } = createCtx({ messageCount: 0, runStatus: "running" });
    (ctx.db as typeof ctx.db & { patch: typeof patch }).patch = patch;
    const { failRun } = await import("../userResearch");

    await failRun.handler(ctx as never, {
      serviceKey: "service-key",
      analysisId: "analysis-1",
      error: "worker error",
    });

    expect(patch).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        status: "failed",
        profiles_completed: 0,
        error: "worker error",
      }),
    );
  });
});
