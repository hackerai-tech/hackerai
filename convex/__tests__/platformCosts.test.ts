import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: unknown) => config),
}));

jest.mock("convex/values", () => ({
  v: {
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    optional: jest.fn(() => "optional"),
    object: jest.fn(() => "object"),
    array: jest.fn(() => "array"),
    union: jest.fn(() => "union"),
    literal: jest.fn(() => "literal"),
  },
}));

jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));

type StoredRow = Record<string, any> & { _id: string };

function makeCtx(initial: StoredRow[] = []) {
  const rows = [...initial];
  let nextId = 1;
  const ctx: any = {
    db: {
      query: jest.fn(() => ({
        withIndex: jest.fn((_name: string, predicate: any) => {
          const constraints: Record<string, any> = {};
          const q = {
            eq(field: string, value: unknown) {
              constraints[field] = value;
              return q;
            },
            gte(field: string, value: unknown) {
              constraints[`gte:${field}`] = value;
              return q;
            },
            lte(field: string, value: unknown) {
              constraints[`lte:${field}`] = value;
              return q;
            },
          };
          predicate(q);
          const matches = rows.filter(
            (row) =>
              row.vendor === constraints.vendor &&
              row.day >= constraints["gte:day"] &&
              row.day <= constraints["lte:day"],
          );
          return { take: async (limit: number) => matches.slice(0, limit) };
        }),
      })),
      insert: jest.fn(async (_table: string, row: Record<string, unknown>) => {
        const id = `new-${nextId++}`;
        rows.push({ _id: id, ...row });
        return id;
      }),
      patch: jest.fn(async (id: string, patch: Record<string, unknown>) => {
        Object.assign(
          rows.find((row) => row._id === id),
          patch,
        );
      }),
      delete: jest.fn(async (id: string) => {
        const index = rows.findIndex((row) => row._id === id);
        if (index >= 0) rows.splice(index, 1);
      }),
    },
  };
  return { ctx, rows };
}

async function replace(ctx: any, overrides: Record<string, unknown> = {}) {
  const { replaceVendorCostWindow } = await import("../platformCosts");
  return await (replaceVendorCostWindow as any).handler(ctx, {
    serviceKey: "service-key",
    vendor: "vercel",
    startDay: "2026-08-30",
    endDay: "2026-08-30",
    observedAt: Date.parse("2026-08-31T12:00:00.000Z"),
    rows: [
      {
        day: "2026-08-30",
        serviceName: "Fluid compute",
        serviceCategory: "Compute",
        billingCurrency: "USD",
        costStatus: "billed",
        billedCostDollars: 12.5,
        effectiveCostDollars: 12,
        usageQuantity: 100,
        usageUnit: "GB-hours",
        sourcePeriodStart: "2026-08-30T00:00:00.000Z",
        sourcePeriodEnd: "2026-08-31T00:00:00.000Z",
        sourceChargeCount: 2,
      },
    ],
    ...overrides,
  });
}

describe("replaceVendorCostWindow", () => {
  beforeEach(() => jest.clearAllMocks());

  it("inserts billed shared costs and remains unchanged on an identical retry", async () => {
    const { ctx, rows } = makeCtx();
    await expect(replace(ctx)).resolves.toEqual({
      inserted: 1,
      updated: 0,
      deleted: 0,
      unchanged: 0,
    });
    expect(rows[0]).toMatchObject({
      vendor: "vercel",
      recognized_cost_dollars: 12.5,
      gross_profit_impact_dollars: -12.5,
    });

    await expect(replace(ctx)).resolves.toEqual({
      inserted: 0,
      updated: 0,
      deleted: 0,
      unchanged: 1,
    });
    expect(ctx.db.patch).not.toHaveBeenCalled();
  });

  it("updates corrected charges and deletes rows removed from the window", async () => {
    const { ctx, rows } = makeCtx();
    await replace(ctx);
    await replace(ctx, {
      rows: [
        {
          day: "2026-08-30",
          serviceName: "Fluid compute",
          serviceCategory: "Compute",
          billingCurrency: "USD",
          costStatus: "billed",
          billedCostDollars: 9,
          sourcePeriodStart: "2026-08-30T00:00:00.000Z",
          sourcePeriodEnd: "2026-08-31T00:00:00.000Z",
        },
      ],
    });
    expect(rows[0]).toMatchObject({
      billed_cost_dollars: 9,
      recognized_cost_dollars: 9,
      gross_profit_impact_dollars: -9,
    });

    await expect(replace(ctx, { rows: [] })).resolves.toEqual({
      inserted: 0,
      updated: 0,
      deleted: 1,
      unchanged: 0,
    });
    expect(rows).toHaveLength(0);
  });

  it("stores Convex usage as metered without recognizing an invented cost", async () => {
    const { ctx, rows } = makeCtx();
    await replace(ctx, {
      vendor: "convex",
      rows: [
        {
          day: "2026-08-30",
          serviceName: "functionCalls",
          serviceCategory: "operations",
          costStatus: "metered",
          usageQuantity: 42,
          usageUnit: "calls",
          sourcePeriodStart: "2026-08-30T00:00:00.000Z",
          sourcePeriodEnd: "2026-08-31T00:00:00.000Z",
        },
      ],
    });
    expect(rows[0]).toMatchObject({
      vendor: "convex",
      cost_status: "metered",
      usage_quantity: 42,
      recognized_cost_dollars: 0,
      gross_profit_impact_dollars: 0,
    });
    expect(rows[0].billed_cost_dollars).toBeUndefined();
  });
});
