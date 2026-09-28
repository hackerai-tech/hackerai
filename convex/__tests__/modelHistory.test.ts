jest.mock("../_generated/server", () => ({
  mutation: (config: unknown) => config,
}));
jest.mock("../lib/utils", () => ({ validateServiceKey: jest.fn() }));
jest.mock("../lib/suspensionGuards", () => ({
  assertUserCanAccessChatHistory: jest.fn(),
}));
import {
  load,
  save,
  invalidateModelHistory,
  deleteModelHistory,
} from "../modelHistory";
import { validateServiceKey } from "../lib/utils";

const invoke = (fn: unknown, ctx: unknown, args: unknown) =>
  (fn as { handler: (ctx: unknown, args: unknown) => Promise<any> }).handler(
    ctx,
    args,
  );
const owner = { serviceKey: "synthetic", chatId: "chat", userId: "owner" };
function database(chat: Record<string, unknown> | null = { user_id: "owner" }) {
  let row: Record<string, any> | undefined;
  const ctx = {
    db: {
      query: (table: string) => ({
        withIndex: () => ({
          unique: async () => (table === "chats" ? chat : (row ?? null)),
        }),
      }),
      insert: async (_table: string, value: Record<string, unknown>) => {
        row = { _id: "snapshot", ...value };
      },
      patch: async (_id: unknown, value: Record<string, unknown>) => {
        Object.assign(row!, value);
      },
      delete: async () => {
        row = undefined;
      },
    },
  };
  return { ctx: ctx as any, row: () => row };
}

describe("backend model history lifecycle", () => {
  beforeEach(() => jest.clearAllMocks());
  it("requires service authentication and chat ownership", async () => {
    expect(
      await invoke(load, database({ user_id: "other" }).ctx, owner),
    ).toBeNull();
    expect(validateServiceKey).toHaveBeenCalledWith("synthetic");
    expect(await invoke(load, database(null).ctx, owner)).toBeNull();
    expect(
      await invoke(
        load,
        database({ user_id: "owner", deletion_started_at: 1 }).ctx,
        owner,
      ),
    ).toBeNull();
  });
  it("persists privately and fences the previous worker when a new run loads", async () => {
    const db = database();
    const first = await invoke(load, db.ctx, owner);
    const args = {
      ...owner,
      revision: first.revision,
      startedAt: 1,
      payload: "private prompt",
    };
    expect(await invoke(save, db.ctx, args)).toBe(true);
    const second = await invoke(load, db.ctx, owner);
    expect(second.payload).toBe("private prompt");
    expect(
      await invoke(save, db.ctx, { ...args, payload: "stale worker" }),
    ).toBe(false);
    expect(db.row()?.payload).toBe("private prompt");
  });
  it("clears payload and rejects in-flight writes after edit/regeneration", async () => {
    const db = database();
    const { revision } = await invoke(load, db.ctx, owner);
    const args = { ...owner, revision, startedAt: 1, payload: "old content" };
    await invoke(save, db.ctx, args);
    await invalidateModelHistory(db.ctx, owner.chatId);
    expect(db.row()?.payload).toBeUndefined();
    expect(await invoke(save, db.ctx, args)).toBe(false);
  });
  it("enforces UTF-8 size bounds and deletes all replay data", async () => {
    const db = database();
    const { revision } = await invoke(load, db.ctx, owner);
    expect(
      await invoke(save, db.ctx, {
        ...owner,
        revision,
        startedAt: 1,
        payload: "字".repeat(250_000),
      }),
    ).toBe(false);
    await deleteModelHistory(db.ctx, owner.chatId);
    expect(db.row()).toBeUndefined();
    expect(
      await invoke(save, db.ctx, {
        ...owner,
        revision,
        startedAt: 1,
        payload: "late write",
      }),
    ).toBe(false);
  });
});
