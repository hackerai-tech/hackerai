jest.mock("../lib/serviceFunctions", () => ({
  query: (d: unknown) => d,
  mutation: (d: unknown) => d,
}));
jest.mock("../lib/utils", () => ({ validateServiceKey: jest.fn() }));
import {
  getPredictionPreference,
  setPredictionPreference,
  getPredictionPreferenceForBackend,
  saveUserCustomization,
} from "../userCustomization";
const read = (ctx: unknown) =>
  (getPredictionPreference as any).handler(ctx, {});
const save = (setPredictionPreference as any).handler;
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

it("defaults legacy accounts on and persists only the authenticated user's choice across later edits", async () => {
  const store = database();
  expect(await read(store.ctx("owner"))).toEqual({ enabled: true });
  expect(store.db.insert).not.toHaveBeenCalled();
  await save(store.ctx("owner"), { enabled: false });
  await (saveUserCustomization as any).handler(store.ctx("owner"), {
    nickname: "Tester",
  });
  expect(await read(store.ctx("owner"))).toEqual({ enabled: false });
  expect(await read(store.ctx("other"))).toEqual({ enabled: true });
  expect(
    await (getPredictionPreferenceForBackend as any).handler(store.ctx(null), {
      serviceKey: "test-only",
      userId: "owner",
    }),
  ).toEqual({ enabled: false });
  await save(store.ctx("owner"), { enabled: true });
  expect(await read(store.ctx("owner"))).toEqual({ enabled: true });
});
it("rejects anonymous and deletion-fenced writes", async () => {
  const store = database();
  expect(await read(store.ctx(null))).toBeNull();
  await expect(save(store.ctx(null), { enabled: false })).rejects.toThrow();
  store.fences.add("owner");
  expect(await read(store.ctx("owner"))).toBeNull();
  await expect(save(store.ctx("owner"), { enabled: false })).rejects.toThrow();
  expect(store.db.insert).not.toHaveBeenCalled();
  expect(store.db.patch).not.toHaveBeenCalled();
});
