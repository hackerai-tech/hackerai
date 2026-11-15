import {
  assertChatHistoryOwner,
  createChatHistoryAccess,
  deleteChatHistoryAccess,
} from "../lib/chatHistoryAccess";

function fixture(access: any = null, chat: any = null) {
  const tables: Record<string, any[]> = {
    chat_history_access: access ? [access] : [],
    chats: chat ? [chat] : [],
  };
  const reads: string[] = [];
  const ctx: any = {
    db: {
      query: (table: string) => ({
        withIndex: (_: string, build: any) => {
          let field: string, value: string;
          build({
            eq: (f: string, v: string) => {
              field = f;
              value = v;
            },
          });
          const read = async () => {
            reads.push(table);
            return tables[table].find((r) => r[field] === value) ?? null;
          };
          return { first: read, unique: read };
        },
      }),
      insert: async (table: string, row: any) => {
        tables[table].push({ _id: "access", ...row });
      },
      delete: async (id: string) => {
        for (const t in tables)
          tables[t] = tables[t].filter((r) => r._id !== id);
      },
    },
  };
  return { ctx, tables, reads };
}

test("stable ownership excludes runtime state from the history read set", async () => {
  const f = fixture(null, { _id: "chat", id: "c", user_id: "owner" });
  await createChatHistoryAccess(f.ctx, "c", "owner");
  await assertChatHistoryOwner(f.ctx, "c", "owner");
  f.tables.chats[0].active_stream_id = "new-run";
  await assertChatHistoryOwner(f.ctx, "c", "owner");
  expect(f.reads).toEqual(["chat_history_access", "chat_history_access"]);
  await expect(
    assertChatHistoryOwner(f.ctx, "c", "other"),
  ).rejects.toMatchObject({ data: { code: "CHAT_UNAUTHORIZED" } });
});

test("legacy ownership and missing chat preserve authorization errors", async () => {
  const f = fixture(null, { _id: "chat", id: "c", user_id: "owner" });
  await assertChatHistoryOwner(f.ctx, "c", "owner");
  await expect(
    assertChatHistoryOwner(f.ctx, "c", "other"),
  ).rejects.toMatchObject({ data: { code: "CHAT_UNAUTHORIZED" } });
  await expect(
    assertChatHistoryOwner(f.ctx, "missing", "owner"),
  ).rejects.toMatchObject({ data: { code: "CHAT_NOT_FOUND" } });
});

test("transactional chat deletion removes the authorization record", async () => {
  const f = fixture(
    { _id: "access", chat_id: "c", user_id: "owner" },
    { _id: "chat", id: "c", user_id: "owner" },
  );
  await deleteChatHistoryAccess(f.ctx, "c");
  await f.ctx.db.delete("chat");
  await expect(
    assertChatHistoryOwner(f.ctx, "c", "owner"),
  ).rejects.toMatchObject({ data: { code: "CHAT_NOT_FOUND" } });
});

jest.mock("../lib/serviceFunctions", () => ({
  internalMutation: (definition: unknown) => definition,
}));

// Exercise the migration handler: reruns must not duplicate access or silently
// overwrite a conflicting owner, and a caller cannot request an unbounded scan.
test("backfill is bounded, idempotent and refuses conflicting ownership", async () => {
  const { backfill } = await import("../chatHistoryAccess");
  const f = fixture(null, { _id: "chat", id: "c", user_id: "owner" });
  const query = f.ctx.db.query;
  const paginate = jest.fn(async () => ({
    page: f.tables.chats,
    isDone: true,
    continueCursor: "done",
  }));
  f.ctx.db.query = (table: string) =>
    table === "chats" ? { paginate } : query(table);
  const run = () =>
    (backfill as any).handler(f.ctx, {
      paginationOpts: { numItems: 10000, cursor: null },
    });
  await expect(run()).resolves.toMatchObject({ created: 1, isDone: true });
  await expect(run()).resolves.toMatchObject({ created: 0 });
  expect(paginate).toHaveBeenCalledWith({
    numItems: 100,
    cursor: null,
    maximumBytesRead: 2 * 1024 * 1024,
  });
  f.tables.chat_history_access[0].user_id = "other";
  await expect(run()).rejects.toThrow("ownership mismatch");
});
