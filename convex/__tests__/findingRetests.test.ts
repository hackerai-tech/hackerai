/** @jest-environment node */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

// Legacy HTTP retest rows have no read, write or run path; only deletion
// remains so chat, finding and user deletion still remove Preview data.

jest.mock("../lib/serviceFunctions", () => ({
  internalMutation: jest.fn((config: any) => config),
}));
jest.mock("../_generated/api", () => ({
  internal: { findingRetests: { deleteForFinding: "deleteForFinding" } },
}));

type Row = { _id: string; [key: string]: any };
type Tables = Record<string, Row[]>;

/** Minimal in-memory Convex reader/writer for index equality reads. */
function createCtx(tables: Tables) {
  const query = (table: string) => ({
    withIndex: (_index: string, build?: (q: any) => any) => {
      const filters: Array<(row: Row) => boolean> = [];
      const q: any = {
        eq: (field: string, value: unknown) => {
          filters.push((row) => row[field] === value);
          return q;
        },
      };
      build?.(q);
      return {
        take: async (n: number) =>
          (tables[table] ?? [])
            .filter((row) => filters.every((filter) => filter(row)))
            .slice(0, n),
      };
    },
  });
  return {
    db: {
      query,
      delete: async (id: string) => {
        for (const [table, rows] of Object.entries(tables))
          tables[table] = rows.filter((row) => row._id !== id);
      },
    },
    scheduler: { runAfter: jest.fn() },
  } as any;
}

describe("legacy finding retest cleanup", () => {
  let mod: typeof import("../findingRetests");
  beforeEach(async () => {
    mod = await import("../findingRetests");
  });

  it("deletes a chat's legacy rows in batches without touching other chats", async () => {
    const tables: Tables = {
      finding_retest_runs: Array.from({ length: 60 }, (_, i) => ({
        _id: `r${i}`,
        user_id: "user-1",
        chat_id: "chat-1",
      })),
      finding_retest_recipes: [
        { _id: "keep", user_id: "user-2", chat_id: "chat-2" },
        { _id: "drop", user_id: "user-1", chat_id: "chat-1" },
      ],
    };
    const ctx = createCtx(tables);
    expect(
      await mod.deleteFindingRetestsForChatBatch(ctx, "user-1", "chat-1"),
    ).toBe(true);
    expect(
      await mod.deleteFindingRetestsForChatBatch(ctx, "user-1", "chat-1"),
    ).toBe(false);
    expect(tables.finding_retest_runs).toHaveLength(0);
    expect(tables.finding_retest_recipes.map((r) => r._id)).toEqual(["keep"]);
  });

  it("deletes a finding's legacy rows for its owner and continues large batches", async () => {
    const tables: Tables = {
      finding_retest_runs: Array.from({ length: 51 }, (_, i) => ({
        _id: `r${i}`,
        user_id: "user-1",
        finding_id: "finding-1",
      })),
      finding_retest_recipes: [
        { _id: "recipe", user_id: "user-1", finding_id: "finding-1" },
        { _id: "other", user_id: "user-1", finding_id: "finding-2" },
      ],
    };
    const ctx = createCtx(tables);
    const args = { findingId: "finding-1", userId: "user-1" };
    await (mod.deleteForFinding as any).handler(ctx, args);
    expect(ctx.scheduler.runAfter).toHaveBeenCalledWith(
      0,
      "deleteForFinding",
      args,
    );
    await (mod.deleteForFinding as any).handler(ctx, args);
    expect(tables.finding_retest_runs).toHaveLength(0);
    expect(tables.finding_retest_recipes.map((r) => r._id)).toEqual(["other"]);
    expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
  });
});
