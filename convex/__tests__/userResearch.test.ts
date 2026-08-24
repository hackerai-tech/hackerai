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
      },
    ],
    research_run_members: [
      {
        _id: "member-1",
        analysis_id: "analysis-1",
        user_id: args.memberUserId ?? userId,
        pseudonym: "U01",
      },
    ],
    chats: [
      {
        _id: "chat-doc-1",
        id: chatId,
        user_id: userId,
        update_time: 1,
      },
    ],
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
          const filters: Array<{ field: string; value: unknown }> = [];
          const q = {
            eq: (field: string, value: unknown) => {
              filters.push({ field, value });
              return q;
            },
          };
          build(q);
          const rows = (tables[table] ?? []).filter((row) =>
            filters.every(({ field, value }) => row[field] === value),
          );
          const ordered = (direction: "asc" | "desc") => {
            const sorted = [...rows].sort(
              (a, b) => (a._creationTime ?? 0) - (b._creationTime ?? 0),
            );
            return direction === "desc" ? sorted.reverse() : sorted;
          };
          return {
            unique: jest.fn(async () => rows[0] ?? null),
            order: jest.fn((direction: "asc" | "desc") => ({
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
      members: [
        { userId: "user-1", pseudonym: "U01" },
        { userId: "user-2", pseudonym: "U02" },
        { userId: "user-3", pseudonym: "U03" },
      ],
      maxChatsPerUser: 12,
      model: "x-ai/grok-4.6",
    });

    expect(insert).toHaveBeenCalledWith(
      "research_runs",
      expect.not.objectContaining({ linear_issue_id: expect.anything() }),
    );
    expect(insert).toHaveBeenCalledTimes(4);
  });
});
