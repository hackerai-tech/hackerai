jest.mock("../_generated/server", () => ({
  mutation: (c: unknown) => c,
  query: (c: unknown) => c,
}));
jest.mock("../lib/utils", () => ({
  validateServiceKey: (key: string) => {
    if (key !== "test-service") throw new Error("Unauthorized");
  },
}));
jest.mock("../lib/suspensionGuards", () => ({
  assertUserCanAccessChatHistory: jest.fn(),
}));
jest.mock("../lib/userDeletionFence", () => ({
  isUserDeletionFenced: jest.fn(async () => false),
}));
import * as skills from "../userSkills";
import { isUserDeletionFenced } from "../lib/userDeletionFence";
function database() {
  const tables = new Map<string, Map<string, any>>();
  let sequence = 0;
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  const db = {
    insert: async (name: string, value: any) => {
      const id = `${name}:${++sequence}`;
      table(name).set(id, { ...value, _id: id });
      return id;
    },
    get: async (id: string) => table(id.split(":")[0]).get(id) ?? null,
    patch: async (id: string, value: any) => {
      Object.assign(await db.get(id), value);
    },
    delete: async (id: string) => {
      table(id.split(":")[0]).delete(id);
    },
    query: (name: string) => ({
      withIndex: (_index: string, apply: any) => {
        const matches: Array<[string, unknown]> = [];
        const q = {
          eq: (key: string, value: unknown) => {
            matches.push([key, value]);
            return q;
          },
        };
        apply(q);
        const rows = () =>
          [...table(name).values()].filter((r) =>
            matches.every(([key, value]) => r[key] === value),
          );
        return {
          take: async (n: number) => rows().slice(0, n),
          unique: async () => rows()[0] ?? null,
        };
      },
    }),
  };
  return db;
}
const call = (fn: any, ctx: any, args = {}) => fn.handler(ctx, args);
describe("private skill ownership and selections", () => {
  let db: ReturnType<typeof database>;
  let alice: any;
  let bob: any;
  const draft = {
    name: "API review",
    description: "For APIs",
    content: "Use two test accounts.",
  };
  beforeEach(() => {
    jest.mocked(isUserDeletionFenced).mockResolvedValue(false);
    db = database();
    alice = {
      db,
      auth: { getUserIdentity: async () => ({ subject: "alice" }) },
    };
    bob = { db, auth: { getUserIdentity: async () => ({ subject: "bob" }) } };
  });
  it("creates, reads, edits and deletes only an owner's skills", async () => {
    const id = await call(skills.save, alice, draft);
    expect(await call(skills.list, alice)).toEqual([
      expect.objectContaining({ id, name: draft.name }),
    ]);
    expect(await call(skills.list, bob)).toEqual([]);
    for (const operation of [skills.get, skills.remove, skills.setDefault])
      await expect(call(operation, bob, { id, enabled: true })).rejects.toThrow(
        "Skill not found",
      );
    await expect(call(skills.save, bob, { ...draft, id })).rejects.toThrow(
      "Skill not found",
    );
    await call(skills.save, alice, {
      ...draft,
      id,
      content: "Updated methodology",
    });
    expect((await call(skills.get, alice, { id })).content).toBe(
      "Updated methodology",
    );
    await call(skills.remove, alice, { id });
    await expect(call(skills.get, alice, { id })).rejects.toThrow();
  });
  it("preserves an explicit empty draft against defaults and snapshots defaults only for new chats", async () => {
    const id = await call(skills.save, alice, draft);
    await call(skills.setDefault, alice, { id, enabled: true });
    expect(
      await call(skills.selection, alice, { chatId: "new-chat" }),
    ).toHaveLength(1);
    await call(skills.select, alice, { chatId: "new-chat", ids: [] });
    expect(
      await skills.snapshotSkillSelection(alice, "alice", "new-chat"),
    ).toEqual([]);
    const initial = await skills.snapshotSkillSelection(
      alice,
      "alice",
      "another-chat",
    );
    await db.insert("chats", {
      id: "another-chat",
      user_id: "alice",
      user_skill_ids: initial,
    });
    await call(skills.setDefault, alice, { id, enabled: false });
    expect(
      await call(skills.selection, alice, { chatId: "another-chat" }),
    ).toHaveLength(1);
    expect(
      await skills.snapshotSkillSelection(alice, "alice", "third-chat"),
    ).toEqual([]);
  });
  it("requires owned chat and selected skill at every runtime load", async () => {
    const id = await call(skills.save, alice, draft);
    const chat = await db.insert("chats", {
      id: "chat",
      user_id: "alice",
      user_skill_ids: [id],
    });
    const request = {
      serviceKey: "test-service",
      userId: "alice",
      chatId: "chat",
      id,
    };
    expect(await call(skills.runtimeLoad, alice, request)).toEqual(draft);
    await expect(
      call(skills.runtimeLoad, alice, { ...request, userId: "bob" }),
    ).rejects.toThrow("Chat not found");
    await expect(
      call(skills.runtimeLoad, alice, { ...request, serviceKey: "bad" }),
    ).rejects.toThrow("Unauthorized");
    await expect(
      call(skills.select, bob, { chatId: "chat", ids: [] }),
    ).rejects.toThrow("Chat not found");
    await db.patch(chat, { user_skill_ids: [] });
    await expect(call(skills.runtimeLoad, alice, request)).rejects.toThrow(
      "not selected",
    );
  });
  it("rejects foreign IDs, more than three skills and mid-response changes", async () => {
    const id = await call(skills.save, bob, draft);
    await expect(
      call(skills.select, alice, { chatId: "draft", ids: [id] }),
    ).rejects.toThrow();
    const ids = await Promise.all(
      [1, 2, 3, 4].map(() => call(skills.save, alice, draft)),
    );
    await expect(
      call(skills.select, alice, { chatId: "draft", ids }),
    ).rejects.toThrow();
    await db.insert("chats", {
      id: "busy",
      user_id: "alice",
      active_stream_id: "stream",
    });
    await expect(
      call(skills.select, alice, { chatId: "busy", ids: [] }),
    ).rejects.toThrow("Wait");
  });
  it("blocks stale writes during account deletion", async () => {
    jest.mocked(isUserDeletionFenced).mockResolvedValue(true);
    await expect(call(skills.save, alice, draft)).rejects.toThrow("deletion");
    await expect(
      call(skills.select, alice, { chatId: "draft", ids: [] }),
    ).rejects.toThrow("deletion");
  });
});
