jest.mock("../_generated/server", () => ({
  query: (definition: unknown) => definition,
  mutation: (definition: unknown) => definition,
}));
jest.mock("../lib/utils", () => ({ validateServiceKey: jest.fn() }));

import {
  getModelImprovementPreference,
  setModelImprovementPreference,
  saveUserCustomization,
} from "../userCustomization";

const read = (ctx: unknown) =>
  (getModelImprovementPreference as any).handler(ctx, {});
const save = (setModelImprovementPreference as any).handler;
const saveCustomization = (saveUserCustomization as any).handler;

function database() {
  const rows: Record<string, any>[] = [];
  const fences = new Set<string>();
  const db = {
    query: jest.fn((table: string) => ({
      withIndex: (_name: string, select: any) => {
        let userId: string;
        select({
          eq: (_field: string, value: string) => {
            userId = value;
          },
        });
        return {
          first: async () =>
            table === "user_deletion_fences"
              ? fences.has(userId)
                ? { user_id: userId }
                : null
              : (rows.find((row) => row.user_id === userId) ?? null),
        };
      },
    })),
    insert: jest.fn(async (_table: string, row: any) => {
      const id = `row-${rows.length}`;
      rows.push({ _id: id, ...row });
      return id;
    }),
    patch: jest.fn(async (id: string, patch: any) => {
      Object.assign(
        rows.find((row) => row._id === id)!,
        patch,
      );
    }),
  };
  const ctx = (subject: string | null) => ({
    db,
    auth: { getUserIdentity: async () => (subject ? { subject } : null) },
  });
  return { rows, fences, db, ctx };
}

describe("model improvement account preference", () => {
  it("defaults missing and legacy preferences to on without creating consent or writing a record", async () => {
    const store = database();
    expect(await read(store.ctx("new"))).toEqual({
      enabled: true,
      updatedAt: null,
    });
    store.rows.push({ _id: "legacy", user_id: "existing", updated_at: 1 });
    expect(await read(store.ctx("existing"))).toEqual({
      enabled: true,
      updatedAt: null,
    });
    expect(store.db.insert).not.toHaveBeenCalled();
    expect(store.db.patch).not.toHaveBeenCalled();
  });

  it("persists an explicit opt-out across new requests and later customization edits", async () => {
    const store = database();
    await save(store.ctx("owner"), { enabled: false });
    const initial = await read(store.ctx("owner"));
    expect(initial).toEqual({ enabled: false, updatedAt: expect.any(Number) });
    await saveCustomization(store.ctx("owner"), { nickname: "Researcher" });
    expect(await read(store.ctx("owner"))).toEqual(initial);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].nickname).toBe("Researcher");
    await save(store.ctx("owner"), { enabled: true });
    expect((await read(store.ctx("owner"))).enabled).toBe(true);
  });

  it("uses the authenticated account and preserves other preferences and other users", async () => {
    const store = database();
    store.rows.push({
      _id: "a",
      user_id: "a",
      include_notes: false,
      extra_usage_enabled: true,
      updated_at: 1,
    });
    await save(store.ctx("a"), { enabled: false });
    expect(store.rows[0]).toMatchObject({
      include_notes: false,
      extra_usage_enabled: true,
    });
    expect(await read(store.ctx("b"))).toEqual({
      enabled: true,
      updatedAt: null,
    });
    await save(store.ctx("b"), { enabled: true });
    expect((await read(store.ctx("a"))).enabled).toBe(false);
  });

  it("rejects anonymous writes and does not report an anonymous account as enabled", async () => {
    const store = database();
    expect(await read(store.ctx(null))).toBeNull();
    await expect(save(store.ctx(null), { enabled: false })).rejects.toThrow();
    expect(store.db.insert).not.toHaveBeenCalled();
  });

  it("cannot recreate preferences during account deletion", async () => {
    const store = database();
    store.fences.add("deleting");
    expect(await read(store.ctx("deleting"))).toBeNull();
    await expect(
      save(store.ctx("deleting"), { enabled: true }),
    ).rejects.toThrow();
    expect(store.db.insert).not.toHaveBeenCalled();
    expect(store.db.patch).not.toHaveBeenCalled();
  });

  it("does not turn a failed lookup into the default-on result", async () => {
    const store = database();
    store.db.query.mockImplementation(() => {
      throw new Error("Unavailable");
    });
    await expect(read(store.ctx("owner"))).rejects.toThrow("Unavailable");
  });
});
