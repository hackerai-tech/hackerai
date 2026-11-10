import { describe, expect, it, jest } from "@jest/globals";
import { getDocumentSize } from "convex/values";

jest.mock("../lib/serviceFunctions", () => ({
  internalMutation: (definition: unknown) => definition,
}));

const { start, advance } = require("../messageSearchMigration");
import {
  deleteMessageWithSearch,
  getMessageSearchMigration,
  insertMessageWithSearch,
  messageCopyText,
  messageCopyTexts,
  patchMessageWithSearch,
  usesSeparateMessageSearch,
} from "../lib/messageSearch";

// Exercise the migration and write helpers together. The fake implements only
// database operations; search relevance/transactions are verified on Preview.
function database() {
  const tables: Record<string, any[]> = {
    messages: [],
    message_search: [],
    message_search_migration: [],
  };
  let sequence = 0;
  const db = {
    insert: async (table: string, value: any) => {
      const row = {
        ...value,
        _id: `${table}-${++sequence}`,
        _creationTime: sequence,
      };
      tables[table].push(row);
      return row._id;
    },
    get: async (id: string) =>
      Object.values(tables)
        .flat()
        .find((r) => r._id === id) ?? null,
    patch: async (id: string, patch: any) => {
      const row = await db.get(id);
      if (!row) throw Error("Missing document");
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete row[key];
        else row[key] = value;
      }
    },
    delete: async (id: string) => {
      for (const rows of Object.values(tables)) {
        const index = rows.findIndex((r) => r._id === id);
        if (index !== -1) rows.splice(index, 1);
      }
    },
    query: (table: string) => {
      let selected = tables[table];
      const query = {
        withIndex: (_index: string, select: any) => {
          const q = {
            eq: (field: string, value: unknown) => {
              selected = selected.filter((r) => r[field] === value);
              return q;
            },
          };
          select(q);
          return query;
        },
        unique: async () => {
          if (selected.length > 1) throw Error("Duplicate");
          return selected[0] ?? null;
        },
        order: () => query,
        paginate: async (opts: any) => {
          const remaining = selected.filter(
            (r) => r._creationTime > Number(opts.cursor),
          );
          const page: any[] = [];
          let bytes = 0;
          for (const row of remaining) {
            if (page.length >= opts.numItems || bytes >= opts.maximumBytesRead)
              break;
            page.push(row);
            bytes += getDocumentSize(row);
          }
          return {
            page,
            isDone: page.length === remaining.length,
            continueCursor: String(page.at(-1)?._creationTime ?? opts.cursor),
          };
        },
      };
      return query;
    },
  };
  return { ctx: { db } as any, tables };
}
const message = (
  id: string,
  content: string | undefined = "searchable text",
) => ({
  id,
  chat_id: "chat",
  user_id: "owner",
  role: "assistant" as const,
  parts: [
    { type: "text", text: "full answer" },
    { type: "tool-terminal", output: "full tool output" },
  ],
  content,
  update_time: 10,
});
async function finish(ctx: any) {
  for (let n = 0; n < 100; n++) {
    if ((await advance.handler(ctx, {})).done) return;
  }
  throw Error("Migration did not finish");
}

describe("message search separation", () => {
  it("stays on legacy search until copying finishes, preserving text and original timestamps", async () => {
    const { ctx, tables } = database();
    const large = {
      ...message("old"),
      parts: [{ type: "text", text: "x".repeat(600_000) }],
      content: "x".repeat(500_000),
    };
    const id = await insertMessageWithSearch(ctx, large);
    await insertMessageWithSearch(ctx, {
      ...message("second"),
      content: undefined,
    });
    const original = JSON.parse(JSON.stringify(await ctx.db.get(id)));
    expect(tables.message_search).toEqual([]);
    await start.handler(ctx, { direction: "separate" });
    await advance.handler(ctx, {});
    expect(
      usesSeparateMessageSearch(await getMessageSearchMigration(ctx)),
    ).toBe(false);
    // New messages and edits during a partial copy must also reach the new index.
    const added = await insertMessageWithSearch(
      ctx,
      message("during-copy", "new text"),
    );
    await patchMessageWithSearch(ctx, await ctx.db.get(id), {
      content: "edited text",
      update_time: 20,
    });
    await finish(ctx);
    expect(
      usesSeparateMessageSearch(await getMessageSearchMigration(ctx)),
    ).toBe(true);
    expect(tables.messages.every((m) => m.content === undefined)).toBe(true);
    expect((await ctx.db.get(id)).parts).toEqual(original.parts);
    expect(
      tables.message_search.find((m) => m.message_id === id),
    ).toMatchObject({
      content: "edited text",
      created_at: original._creationTime,
    });
    expect(
      tables.message_search.find((m) => m.message_id === added).content,
    ).toBe("new text");
    expect(
      tables.message_search.find((m) => m.id === "second").content,
    ).toBeUndefined();
    await finish(ctx);
    expect(tables.message_search).toHaveLength(3);
  });

  it("updates visibility and recovered text atomically with the body and deletes both records", async () => {
    const { ctx, tables } = database();
    await start.handler(ctx, { direction: "separate" });
    await finish(ctx);
    const id = await insertMessageWithSearch(ctx, message("new", "original"));
    await patchMessageWithSearch(ctx, await ctx.db.get(id), {
      is_hidden: true,
      update_time: 20,
    });
    expect(tables.message_search[0]).toMatchObject({
      content: "original",
      is_hidden: true,
    });
    await patchMessageWithSearch(ctx, await ctx.db.get(id), {
      parts: [{ type: "text", text: "recovered" }],
      content: "recovered",
      is_hidden: false,
      update_time: 30,
    });
    expect(tables.message_search[0]).toMatchObject({
      content: "recovered",
      is_hidden: false,
    });
    expect(await ctx.db.get(id)).toMatchObject({
      parts: [{ type: "text", text: "recovered" }],
    });
    expect((await ctx.db.get(id)).content).toBeUndefined();
    await deleteMessageWithSearch(ctx, await ctx.db.get(id));
    expect(tables.messages).toEqual([]);
    expect(tables.message_search).toEqual([]);
  });

  it("restores exact indexed text before switching readers back, including writes during rollback", async () => {
    const { ctx, tables } = database();
    const id = await insertMessageWithSearch(
      ctx,
      message("old", "shortened search text"),
    );
    await start.handler(ctx, { direction: "separate" });
    await finish(ctx);
    await start.handler(ctx, { direction: "restore" });
    expect(
      usesSeparateMessageSearch(await getMessageSearchMigration(ctx)),
    ).toBe(true);
    await insertMessageWithSearch(ctx, message("during-restore", "new text"));
    await patchMessageWithSearch(ctx, await ctx.db.get(id), {
      content: "updated during restore",
      update_time: 40,
    });
    await finish(ctx);
    expect(
      usesSeparateMessageSearch(await getMessageSearchMigration(ctx)),
    ).toBe(false);
    expect(tables.messages.map((m) => m.content)).toEqual([
      "updated during restore",
      "new text",
    ]);
    await start.handler(ctx, { direction: "separate" });
    await finish(ctx);
    expect(tables.message_search).toHaveLength(2);
    expect(tables.message_search.map((m) => m.content)).toEqual([
      "updated during restore",
      "new text",
    ]);
  });

  it("copies the exact indexed prefix so a large branch remains restorable", async () => {
    const { ctx, tables } = database();
    const original = {
      ...message("large", "x".repeat(200_000)),
      parts: [{ type: "text", text: "x".repeat(700_000) }],
    };
    const sourceId = await insertMessageWithSearch(ctx, original);
    await start.handler(ctx, { direction: "separate" });
    await finish(ctx);
    const source = await ctx.db.get(sourceId);
    const content = await messageCopyText(ctx, source);
    await insertMessageWithSearch(ctx, { ...original, id: "copy", content });
    await start.handler(ctx, { direction: "restore" });
    await finish(ctx);
    expect(tables.messages.map((m) => m.content)).toEqual([
      original.content,
      original.content,
    ]);
    expect(tables.messages.every((m) => getDocumentSize(m) < 1024 * 1024)).toBe(
      true,
    );
  });

  it("copies requested messages in order when a bounded search page contains different rows", async () => {
    const { ctx, tables } = database();
    await start.handler(ctx, { direction: "separate" });
    await finish(ctx);
    await insertMessageWithSearch(ctx, message("outside", "not requested"));
    const first = await insertMessageWithSearch(
      ctx,
      message("first", "exact prefix"),
    );
    const second = await insertMessageWithSearch(ctx, {
      ...message("second"),
      content: undefined,
    });
    const requested = [await ctx.db.get(second), await ctx.db.get(first)];
    const state = await getMessageSearchMigration(ctx);
    expect(await messageCopyTexts(ctx, requested, state)).toEqual([
      undefined,
      "exact prefix",
    ]);
    tables.message_search.splice(
      tables.message_search.findIndex((row) => row.message_id === second),
      1,
    );
    await expect(messageCopyTexts(ctx, requested, state)).rejects.toThrow(
      "Message search document missing",
    );
  });

  it("rejects edits that would make legacy restoration exceed the document limit", async () => {
    const { ctx } = database();
    await start.handler(ctx, { direction: "separate" });
    await finish(ctx);
    const id = await insertMessageWithSearch(ctx, message("edit"));
    const text = "x".repeat(700_000);
    await expect(
      patchMessageWithSearch(ctx, await ctx.db.get(id), {
        parts: [{ type: "text", text }],
        content: text,
      }),
    ).rejects.toThrow("Message is too large to save");
    expect((await ctx.db.get(id)).parts).toEqual(message("edit").parts);
  });

  it("allows cancellation of an incomplete copy without making missing rows searchable", async () => {
    const { ctx } = database();
    await insertMessageWithSearch(ctx, message("old"));
    await start.handler(ctx, { direction: "separate" });
    await start.handler(ctx, { direction: "restore" });
    expect((await getMessageSearchMigration(ctx)).phase).toBe("legacy");
    expect(
      usesSeparateMessageSearch(await getMessageSearchMigration(ctx)),
    ).toBe(false);
  });
});
