import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
}));

jest.mock("convex/values", () => ({
  v: {
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    boolean: jest.fn(() => "boolean"),
    optional: jest.fn(() => "optional"),
    object: jest.fn(() => "object"),
    union: jest.fn(() => "union"),
    literal: jest.fn(() => "literal"),
  },
}));

jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));

const SERVICE_KEY = "test-service-key";
const REPORTING_START = Date.UTC(2026, 4, 31);

type UsageLogRow = {
  _id: string;
  user_id: string;
  organization_id?: string;
  _creationTime: number;
  type: "included" | "extra";
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_tokens: number;
  cost_dollars: number;
  model_cost_dollars?: number;
  non_model_cost_dollars?: number;
};

type RevenueRow = {
  _id: string;
  entity_type: "user" | "organization";
  entity_id: string;
  user_id?: string;
  organization_id?: string;
  occurred_at: number;
  gross_revenue_dollars: number;
  net_revenue_dollars: number;
  mrr_dollars?: number;
};

type UnitEconomicsDailyRow = {
  _id: string;
  entity_type: "user" | "organization";
  entity_id: string;
  user_id?: string;
  organization_id?: string;
  day: string;
  gross_revenue_dollars: number;
  net_revenue_dollars: number;
  total_cost_dollars: number;
  gross_profit_dollars: number;
};

function makeMockCtx(opts?: {
  usage?: UsageLogRow[];
  revenue?: RevenueRow[];
  rollups?: UnitEconomicsDailyRow[];
}) {
  const usage = [...(opts?.usage ?? [])];
  const revenue = [...(opts?.revenue ?? [])];
  const rollups = [...(opts?.rollups ?? [])];
  let nextId = 1;
  const mintId = () => `id-${nextId++}`;

  const buildQuery = (table: string) => ({
    withIndex: jest.fn((_indexName: string, predicate: any) => {
      const eqs: Record<string, any> = {};
      const gtes: Record<string, any> = {};
      const ltes: Record<string, any> = {};
      const captureProxy = {
        eq: (field: string, value: any) => {
          eqs[field] = value;
          return captureProxy;
        },
        gte: (field: string, value: any) => {
          gtes[field] = value;
          return captureProxy;
        },
        lte: (field: string, value: any) => {
          ltes[field] = value;
          return captureProxy;
        },
      };
      predicate(captureProxy);

      const inRange = (row: any, field: string) =>
        (gtes[field] === undefined || row[field] >= gtes[field]) &&
        (ltes[field] === undefined || row[field] <= ltes[field]);

      const matches = (() => {
        if (table === "usage_logs") {
          return usage.filter((row) => {
            if (eqs.user_id && row.user_id !== eqs.user_id) return false;
            if (
              eqs.organization_id &&
              row.organization_id !== eqs.organization_id
            ) {
              return false;
            }
            return inRange(row, "_creationTime");
          });
        }
        if (table === "revenue_events") {
          return revenue.filter(
            (row) =>
              row.entity_type === eqs.entity_type &&
              row.entity_id === eqs.entity_id &&
              inRange(row, "occurred_at"),
          );
        }
        if (table === "unit_economics_daily") {
          return rollups.filter((row) => {
            if (eqs.entity_type && row.entity_type !== eqs.entity_type) {
              return false;
            }
            if (eqs.entity_id && row.entity_id !== eqs.entity_id) return false;
            if (eqs.day && row.day !== eqs.day) return false;
            return inRange(row, "day");
          });
        }
        return [];
      })();

      return {
        take: async (limit: number) => matches.slice(0, limit),
        collect: async () => matches,
        unique: async () => {
          if (matches.length === 0) return null;
          if (matches.length > 1) throw new Error(`duplicate ${table} rows`);
          return matches[0];
        },
      };
    }),
  });

  const ctx: any = {
    db: {
      query: jest.fn((table: string) => buildQuery(table)),
      insert: jest.fn(async (table: string, doc: any) => {
        const id = mintId();
        const row = { _id: id, ...doc };
        if (table === "unit_economics_daily") rollups.push(row);
        else throw new Error(`unexpected table: ${table}`);
        return id;
      }),
      patch: jest.fn(async (id: string, patch: any) => {
        const row = rollups.find((candidate) => candidate._id === id);
        if (!row) throw new Error(`row ${id} not found`);
        Object.assign(row, patch);
      }),
      delete: jest.fn(async (id: string) => {
        const index = rollups.findIndex((candidate) => candidate._id === id);
        if (index !== -1) rollups.splice(index, 1);
      }),
    },
  };

  return { ctx, rollups };
}

async function callRebuild(ctx: any, args: Record<string, any>) {
  const { rebuildEntityDailyRollups } = await import("../unitEconomics");
  return (rebuildEntityDailyRollups as any).handler(ctx, {
    serviceKey: SERVICE_KEY,
    ...args,
  });
}

async function callListForPostHog(ctx: any, args: Record<string, any>) {
  const { listDailyRollupsForPostHog } = await import("../unitEconomics");
  return (listDailyRollupsForPostHog as any).handler(ctx, {
    serviceKey: SERVICE_KEY,
    ...args,
  });
}

describe("unit economics reporting window", () => {
  beforeEach(() => jest.clearAllMocks());

  it("excludes pre-reporting usage and revenue rows from normal rebuilds", async () => {
    const userId = "user_1";
    const { ctx, rollups } = makeMockCtx({
      usage: [
        {
          _id: "usage-old",
          user_id: userId,
          _creationTime: REPORTING_START - 1,
          type: "included",
          input_tokens: 10,
          output_tokens: 10,
          total_tokens: 20,
          cost_dollars: 5,
          model_cost_dollars: 5,
        },
        {
          _id: "usage-new",
          user_id: userId,
          _creationTime: REPORTING_START + 60_000,
          type: "included",
          input_tokens: 20,
          output_tokens: 20,
          total_tokens: 40,
          cost_dollars: 2,
          model_cost_dollars: 2,
        },
      ],
      revenue: [
        {
          _id: "revenue-old",
          entity_type: "user",
          entity_id: userId,
          user_id: userId,
          occurred_at: REPORTING_START - 1,
          gross_revenue_dollars: 100,
          net_revenue_dollars: 100,
        },
        {
          _id: "revenue-new",
          entity_type: "user",
          entity_id: userId,
          user_id: userId,
          occurred_at: REPORTING_START + 60_000,
          gross_revenue_dollars: 20,
          net_revenue_dollars: 20,
        },
      ],
    });

    const result = await callRebuild(ctx, {
      entityType: "user",
      entityId: userId,
      startTime: 0,
      endTime: REPORTING_START + 120_000,
    });

    expect(result).toMatchObject({
      usageRowsApplied: 1,
      revenueRowsApplied: 1,
      truncated: false,
    });
    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({
      entity_type: "user",
      entity_id: userId,
      day: "2026-05-31",
      net_revenue_dollars: 20,
      total_cost_dollars: 2,
      gross_profit_dollars: 18,
    });
  });

  it("clamps PostHog exports unless historical reporting is requested", async () => {
    const { ctx } = makeMockCtx({
      rollups: [
        {
          _id: "rollup-old",
          entity_type: "user",
          entity_id: "user_1",
          user_id: "user_1",
          day: "2026-05-30",
          gross_revenue_dollars: 0,
          net_revenue_dollars: 0,
          total_cost_dollars: 5,
          gross_profit_dollars: -5,
        },
        {
          _id: "rollup-new",
          entity_type: "user",
          entity_id: "user_1",
          user_id: "user_1",
          day: "2026-05-31",
          gross_revenue_dollars: 20,
          net_revenue_dollars: 20,
          total_cost_dollars: 2,
          gross_profit_dollars: 18,
        },
      ],
    });

    const normalRows = await callListForPostHog(ctx, {
      startDay: "2026-01-01",
      endDay: "2026-05-31",
    });
    const historicalRows = await callListForPostHog(ctx, {
      startDay: "2026-01-01",
      endDay: "2026-05-31",
      includeHistorical: true,
    });

    expect(normalRows.map((row: UnitEconomicsDailyRow) => row.day)).toEqual([
      "2026-05-31",
    ]);
    expect(historicalRows.map((row: UnitEconomicsDailyRow) => row.day)).toEqual(
      ["2026-05-30", "2026-05-31"],
    );
  });
});
