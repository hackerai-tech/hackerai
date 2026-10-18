import {
  get,
  getForBackend,
  getRetrySource,
  beginUserMessage,
  commitUserMessage,
  claimClarification,
  edit,
} from "../engagementScopes";
import { validateServiceKey } from "../lib/utils";
import { assertUserCanAccessChatHistory } from "../lib/suspensionGuards";
jest.mock("../lib/serviceFunctions", () => ({
  query: (c: unknown) => c,
  mutation: (c: unknown) => c,
}));
jest.mock("../lib/utils", () => ({ validateServiceKey: jest.fn() }));
jest.mock("../lib/suspensionGuards", () => ({
  assertUserCanAccessChatHistory: jest.fn(),
}));
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

it("lets old workers/admission finish without loading or changing saved scope", async () => {
  const db = database();
  await db.insert("chats", {
    id: "chat",
    user_id: "owner",
    engagement_scope_expected: true,
  });
  await db.insert("engagement_scopes", {
    chat_id: "chat",
    status: "unavailable",
  });
  const before = clone([...db.rows.values()]);
  const query = jest.spyOn(db.ctx.db, "query");
  const args = { serviceKey: "test", chatId: "chat", userId: "owner" };
  const call = (fn: any, input: any) => fn.handler(db.ctx, input);
  expect(await call(getForBackend, args)).toBeNull();
  expect(await call(getRetrySource, args)).toBeNull();
  expect(await call(get, { chatId: "chat" })).toBeNull();
  expect(await call(beginUserMessage, { ...args, messageId: "m" })).toEqual({
    complete: true,
    revision: 0,
    sourceText: "",
    current: null,
  });
  expect(
    await call(commitUserMessage, {
      ...args,
      messageId: "m",
      expectedRevision: 1,
      policy: { rules: [], restrictions: [] },
      clarification: "",
      unavailable: true,
    }),
  ).toBe(false);
  expect(await call(claimClarification, { ...args, revision: 1 })).toBe(false);
  await expect(
    call(edit, {
      chatId: "chat",
      expectedRevision: 1,
      policy: { rules: [], restrictions: [] },
    }),
  ).rejects.toThrow("retired");
  expect([...db.rows.values()]).toEqual(before);
  expect(query.mock.calls.every(([table]) => table === "chats")).toBe(true);
});

it("retains service authentication, ownership, and suspension guards on compatibility endpoints", async () => {
  const db = database();
  await db.insert("chats", { id: "chat", user_id: "owner" });
  const args = { serviceKey: "test", chatId: "chat", userId: "other" };
  await expect((getForBackend as any).handler(db.ctx, args)).rejects.toThrow(
    "Chat unavailable",
  );
  (validateServiceKey as jest.Mock).mockImplementationOnce(() => {
    throw new Error("Invalid service key");
  });
  await expect(
    (getForBackend as any).handler(db.ctx, { ...args, userId: "owner" }),
  ).rejects.toThrow("Invalid service key");
  (assertUserCanAccessChatHistory as jest.Mock).mockRejectedValueOnce(
    new Error("Suspended"),
  );
  await expect(
    (getForBackend as any).handler(db.ctx, { ...args, userId: "owner" }),
  ).rejects.toThrow("Suspended");
  db.ctx.auth.getUserIdentity = async () => null;
  await expect(
    (get as any).handler(db.ctx, { chatId: "chat" }),
  ).rejects.toThrow("Unauthenticated");
});
