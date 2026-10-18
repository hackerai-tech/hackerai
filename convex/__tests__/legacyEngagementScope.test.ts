import { deleteScopeBatch } from "../lib/legacyEngagementScope";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function database() {
  let next = 0;
  const rows = new Map<string, any>();
  const insert = async (table: string, value: any) => {
    const _id = `${table}:${++next}`;
    rows.set(_id, { ...clone(value), _id, _creationTime: next, table });
    return _id;
  };
  const ctx: any = {
    auth: { getUserIdentity: async () => ({ subject: "owner" }) },
    db: {
      insert,
      patch: async (id: string, update: any) => {
        if (!rows.has(id)) throw new Error("missing");
        rows.set(id, { ...rows.get(id), ...clone(update) });
      },
      delete: async (id: string) => {
        rows.delete(id);
      },
      query: (table: string) => ({
        withIndex: (_index: string, build: any) => {
          const equals: [string, unknown][] = [];
          const q = {
            eq: (k: string, v: unknown) => {
              equals.push([k, v]);
              return q;
            },
          };
          build(q);
          const found = () =>
            [...rows.values()]
              .filter(
                (r) =>
                  r.table === table && equals.every(([k, v]) => r[k] === v),
              )
              .map((r) => clone(r));
          return {
            unique: async () => found()[0] ?? null,
            take: async (n: number) => found().slice(0, n),
          };
        },
      }),
    },
  };
  return { ctx, rows, insert };
}

it("cleans legacy scope records only for the deleted chat, in bounded batches", async () => {
  const db = database();
  await db.insert("engagement_scopes", { chat_id: "chat" });
  await db.insert("engagement_scopes", { chat_id: "other" });
  for (let i = 0; i < 101; i++) {
    await db.insert("engagement_scope_events", {
      chat_id: "chat",
      source_id: String(i),
    });
  }
  await db.insert("engagement_scope_events", {
    chat_id: "other",
    source_id: "keep",
  });
  expect(await deleteScopeBatch(db.ctx, "chat")).toBe(true);
  expect(
    [...db.rows.values()].filter((r) => r.chat_id === "chat"),
  ).toHaveLength(2);
  expect(await deleteScopeBatch(db.ctx, "chat")).toBe(false);
  expect(
    [...db.rows.values()].filter((r) => r.chat_id === "chat"),
  ).toHaveLength(0);
  expect(
    [...db.rows.values()].filter((r) => r.chat_id === "other"),
  ).toHaveLength(2);
});
