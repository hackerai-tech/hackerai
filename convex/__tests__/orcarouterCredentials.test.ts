jest.mock("../_generated/server", () => ({
  query: (definition: unknown) => definition,
  mutation: (definition: unknown) => definition,
}));
jest.mock("../lib/utils", () => ({ validateServiceKey: jest.fn() }));

import {
  clearForBackend,
  getForBackend,
  markNeedsReauthForBackend,
  saveForBackend,
} from "../orcarouterCredentials";

// Small indexed table fixture for the handlers under test.
function fixture() {
  const rows: any[] = [];
  const db = {
    query: () => {
      const filters: Array<[string, unknown]> = [];
      const chain: any = {
        withIndex: (_index: string, filter: (builder: any) => unknown) => {
          const builder: any = {
            eq: (key: string, value: unknown) => {
              filters.push([key, value]);
              return builder;
            },
          };
          filter(builder);
          return chain;
        },
        collect: async () =>
          rows.filter((row) =>
            filters.every(([key, value]) => row[key] === value),
          ),
        first: async () => (await chain.collect())[0] ?? null,
      };
      return chain;
    },
    insert: async (_table: string, row: any) => {
      const id = `row-${rows.length}`;
      rows.push({ ...row, _id: id });
      return id;
    },
    patch: async (id: string, patch: any) =>
      Object.assign(
        rows.find((row) => row._id === id),
        patch,
      ),
    delete: async (id: string) => {
      rows.splice(
        rows.findIndex((row) => row._id === id),
        1,
      );
    },
  };
  return { ctx: { db }, rows };
}

const handler = (fn: unknown) =>
  (fn as { handler: (ctx: any, args: any) => Promise<any> }).handler;

const save = (ctx: any, source: "api_key" | "pkce", key: string) =>
  handler(saveForBackend)(ctx, {
    serviceKey: "k",
    userId: "user-a",
    encryptedKey: `sealed-${key}`,
    keyHint: `…${key.slice(-4)}`,
    source,
  });

describe("orcarouterCredentials", () => {
  it("increments the generation on every save and reactivates the row", async () => {
    const { ctx, rows } = fixture();
    await expect(save(ctx, "api_key", "sk-orca-aaaa")).resolves.toEqual({
      generation: 1,
    });
    await handler(markNeedsReauthForBackend)(ctx, {
      serviceKey: "k",
      userId: "user-a",
      generation: 1,
    });
    await expect(save(ctx, "pkce", "sk-orca-bbbb")).resolves.toEqual({
      generation: 2,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "pkce",
      status: "active",
      generation: 2,
    });
  });

  it("ignores a late 401 from an older credential generation", async () => {
    const { ctx } = fixture();
    await save(ctx, "api_key", "sk-orca-aaaa");
    await save(ctx, "pkce", "sk-orca-bbbb");

    await expect(
      handler(markNeedsReauthForBackend)(ctx, {
        serviceKey: "k",
        userId: "user-a",
        generation: 1,
      }),
    ).resolves.toBe(false);
    const row = await handler(getForBackend)(ctx, {
      serviceKey: "k",
      userId: "user-a",
    });
    expect(row.status).toBe("active");
  });

  it("marks the current generation without deleting the stored key", async () => {
    const { ctx } = fixture();
    await save(ctx, "pkce", "sk-orca-bbbb");
    await expect(
      handler(markNeedsReauthForBackend)(ctx, {
        serviceKey: "k",
        userId: "user-a",
        generation: 1,
      }),
    ).resolves.toBe(true);
    const row = await handler(getForBackend)(ctx, {
      serviceKey: "k",
      userId: "user-a",
    });
    expect(row).toMatchObject({
      status: "needs_reauth",
      encrypted_key: "sealed-sk-orca-bbbb",
    });
  });

  it("clears the credential on disconnect", async () => {
    const { ctx, rows } = fixture();
    await save(ctx, "api_key", "sk-orca-aaaa");
    await handler(clearForBackend)(ctx, { serviceKey: "k", userId: "user-a" });
    expect(rows).toHaveLength(0);
  });
});
