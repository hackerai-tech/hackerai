import { describe, expect, it, jest } from "@jest/globals";

jest.mock("../lib/serviceFunctions", () => ({
  internalMutation: (config: unknown) => config,
}));

const { backfillNoteSearchMetadata } =
  require("../noteMigrations") as typeof import("../noteMigrations");

function fixture(rows: Record<string, any>[]) {
  const patches: [string, Record<string, unknown>][] = [];
  const ctx: any = {
    db: {
      query: () => ({
        paginate: async ({
          numItems,
          cursor,
        }: {
          numItems: number;
          cursor: string | null;
        }) => {
          const start = cursor ? Number(cursor) : 0;
          const end = Math.min(rows.length, start + numItems);
          return {
            page: rows.slice(start, end),
            isDone: end >= rows.length,
            continueCursor: String(end),
          };
        },
      }),
      patch: async (id: string, fields: Record<string, unknown>) => {
        patches.push([id, fields]);
        Object.assign(
          rows.find((row) => row._id === id)!,
          fields,
        );
      },
    },
  };
  return { ctx, patches };
}

const run = (ctx: unknown, cursor: string | null, numItems = 2) =>
  (backfillNoteSearchMetadata as any).handler(ctx, {
    paginationOpts: { numItems, cursor },
  });

describe("note search metadata backfill", () => {
  it("fills legacy rows in bounded pages without touching timestamps, then is a no-op", async () => {
    const rows = [
      {
        _id: "n1",
        title: "GraphQL batching",
        tags: ["api"],
        updated_at: 10,
        observed_at: 5,
      },
      { _id: "n2", title: "Zulu scope", tags: [], target: "label:zulu bank" },
      { _id: "n3", title: "Host note", tags: [], target: "alpha.example" },
    ];
    const { ctx, patches } = fixture(rows);

    const first = await run(ctx, null);
    expect(first).toMatchObject({ isDone: false, scanned: 2, updated: 2 });
    const second = await run(ctx, first.continueCursor);
    expect(second).toMatchObject({ isDone: true, scanned: 1, updated: 1 });

    expect(rows.map((row) => (row as any).search_metadata)).toEqual([
      "GraphQL batching api",
      "zulu bank Zulu scope",
      "Host note",
    ]);
    // Only the derived field is written; edit and observation dates stay.
    for (const [, fields] of patches)
      expect(Object.keys(fields)).toEqual(["search_metadata"]);
    expect(rows[0]).toMatchObject({ updated_at: 10, observed_at: 5 });

    patches.length = 0;
    expect(await run(ctx, null, 100)).toMatchObject({ updated: 0 });
    expect(patches).toEqual([]);
  });

  it("caps the page size", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      _id: `n${i}`,
      title: "t",
      tags: [],
    }));
    const { ctx } = fixture(rows);
    expect(await run(ctx, null, 10_000)).toMatchObject({ scanned: 100 });
  });
});
