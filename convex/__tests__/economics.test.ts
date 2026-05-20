import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
}));

jest.mock("convex/values", () => ({
  v: {
    any: jest.fn(() => "any"),
    boolean: jest.fn(() => "boolean"),
    literal: jest.fn(() => "literal"),
    null: jest.fn(() => "null"),
    number: jest.fn(() => "number"),
    object: jest.fn(() => "object"),
    optional: jest.fn(() => "optional"),
    string: jest.fn(() => "string"),
    union: jest.fn(() => "union"),
  },
}));

jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));

type Row = Record<string, any> & { _id: string };

function makeCtx() {
  const tables: Record<string, Row[]> = {
    user_accounts: [],
    user_economics_daily: [],
    processed_webhooks: [],
  };

  const matches = (row: Row, filters: Array<[string, any]>) =>
    filters.every(([field, value]) => row[field] === value);

  const makeQueryResult = (table: string, filters: Array<[string, any]>) => ({
    unique: async () => {
      const rows = tables[table].filter((row) => matches(row, filters));
      if (rows.length > 1) throw new Error("not unique");
      return rows[0] ?? null;
    },
    first: async () =>
      tables[table].find((row) => matches(row, filters)) ?? null,
    collect: async () => tables[table].filter((row) => matches(row, filters)),
  });

  const ctx: any = {
    db: {
      query: jest.fn((table: string) => ({
        withIndex: jest.fn((_indexName: string, predicate: any) => {
          const filters: Array<[string, any]> = [];
          predicate({
            eq: (field: string, value: any) => {
              filters.push([field, value]);
              return {
                eq: (nextField: string, nextValue: any) => {
                  filters.push([nextField, nextValue]);
                  return {
                    eq: (thirdField: string, thirdValue: any) => {
                      filters.push([thirdField, thirdValue]);
                      return {
                        eq: (fourthField: string, fourthValue: any) => {
                          filters.push([fourthField, fourthValue]);
                          return {
                            eq: (fifthField: string, fifthValue: any) => {
                              filters.push([fifthField, fifthValue]);
                              return {};
                            },
                          };
                        },
                      };
                    },
                  };
                },
              };
            },
            gte: () => ({ lte: () => ({}) }),
          });
          return makeQueryResult(table, filters);
        }),
        collect: async () => tables[table],
      })),
      insert: jest.fn(async (table: string, doc: Record<string, any>) => {
        const row = { _id: `${table}-${tables[table].length + 1}`, ...doc };
        tables[table].push(row);
        return row._id;
      }),
      patch: jest.fn(async (id: string, patch: Record<string, any>) => {
        for (const rows of Object.values(tables)) {
          const row = rows.find((candidate) => candidate._id === id);
          if (row) Object.assign(row, patch);
        }
      }),
    },
  };

  return { ctx, tables };
}

const serviceKey = "service-key";

describe("economics aggregates", () => {
  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-20T12:00:00Z"));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("aggregates daily usage into a single user/day/tier row", async () => {
    const { aggregateUsage } = await import("../economics");
    const { ctx, tables } = makeCtx();

    const args = {
      serviceKey,
      user_id: "user_1",
      subscription_tier: "free" as const,
      mode: "ask" as const,
      model: "auto",
      type: "included" as const,
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 3,
      total_tokens: 30,
      model_cost_dollars: 0.01,
      non_model_cost_dollars: 0,
      total_cost_dollars: 0.01,
    };

    await (aggregateUsage as any).handler(ctx, args);
    await (aggregateUsage as any).handler(ctx, args);

    expect(tables.user_economics_daily).toHaveLength(1);
    expect(tables.user_economics_daily[0]).toMatchObject({
      day: "2026-05-20",
      request_count: 2,
      input_tokens: 20,
      output_tokens: 40,
      llm_cost_dollars: 0.02,
      total_cost_dollars: 0.02,
      gross_revenue_dollars: 0,
      net_revenue_dollars: 0,
    });
    expect(tables.user_accounts[0]).toMatchObject({
      user_id: "user_1",
      current_subscription_tier: "free",
    });
  });

  it("adds revenue to the same daily economics table", async () => {
    const { recordRevenueEvent } = await import("../economics");
    const { ctx, tables } = makeCtx();

    const args = {
      serviceKey,
      dedupe_key: "evt_1:user_1",
      stripe_event_id: "evt_1",
      event_type: "invoice.paid",
      revenue_type: "subscription" as const,
      occurred_at: Date.parse("2026-05-20T01:00:00Z"),
      user_id: "user_1",
      organization_id: "org_1",
      stripe_customer_id: "cus_1",
      tier: "pro" as const,
      currency: "usd",
      gross_revenue_dollars: 25,
      refund_dollars: 0,
      dispute_dollars: 0,
      net_revenue_dollars: 25,
    };

    const result = await (recordRevenueEvent as any).handler(ctx, args);
    const duplicate = await (recordRevenueEvent as any).handler(ctx, args);

    expect(result).toEqual({ alreadyProcessed: false });
    expect(duplicate).toEqual({ alreadyProcessed: true });
    expect(tables.user_economics_daily).toHaveLength(1);
    expect(tables.user_economics_daily[0]).toMatchObject({
      gross_revenue_dollars: 25,
      net_revenue_dollars: 25,
      total_cost_dollars: 0,
    });
    expect(tables.user_accounts[0]).toMatchObject({
      user_id: "user_1",
      current_subscription_tier: "pro",
      first_paid_at: args.occurred_at,
    });
    expect(tables.processed_webhooks).toHaveLength(1);
    expect(tables.processed_webhooks[0]).toMatchObject({
      event_id: "economics:evt_1:user_1",
      status: "completed",
    });
  });
});
