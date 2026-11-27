import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { recordRevenueEventInternal } from "../unitEconomicsLib";

jest.mock("../lib/serviceFunctions", () => ({
  mutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
  internalMutation: jest.fn((config: any) => config),
  internalQuery: jest.fn((config: any) => config),
}));
jest.mock("convex/values", () => {
  const validator = jest.fn(() => "validator");
  return {
    v: new Proxy({}, { get: () => validator }),
  };
});
jest.mock("../lib/utils", () => ({ validateServiceKey: jest.fn() }));
jest.mock("../lib/logger", () => ({
  convexLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

type Row = { _id: string; [field: string]: any };

/**
 * In-memory tables whose index reads honor eq/gte/lt/lte bounds on the named
 * fields, ordered by the indexed `occurred_at` or `day` field.
 */
function makeDb(seed: Record<string, Array<Record<string, any>>> = {}) {
  const tables: Record<string, Row[]> = {};
  let nextId = 1;
  const table = (name: string) => (tables[name] ??= []);
  for (const [name, rows] of Object.entries(seed)) {
    for (const row of rows)
      table(name).push({ _id: `seed-${nextId++}`, ...row });
  }

  const ctx: any = {
    db: {
      query: (name: string) => ({
        withIndex: (_index: string, predicate: (q: any) => unknown) => {
          const checks: Array<(row: Row) => boolean> = [];
          const q: any = {
            eq: (f: string, v: unknown) => (checks.push((r) => r[f] === v), q),
            gte: (f: string, v: any) => (checks.push((r) => r[f] >= v), q),
            lt: (f: string, v: any) => (checks.push((r) => r[f] < v), q),
            lte: (f: string, v: any) => (checks.push((r) => r[f] <= v), q),
          };
          predicate(q);
          const matches = () =>
            table(name)
              .filter((row) => checks.every((check) => check(row)))
              .sort((a, b) =>
                String(a.occurred_at ?? a.day).localeCompare(
                  String(b.occurred_at ?? b.day),
                ),
              );
          return {
            take: async (n: number) => matches().slice(0, n),
            collect: async () => matches(),
            first: async () => matches()[0] ?? null,
            unique: async () => {
              const found = matches();
              if (found.length > 1) throw new Error(`duplicate ${name} rows`);
              return found[0] ?? null;
            },
          };
        },
      }),
      insert: async (name: string, doc: Record<string, any>) => {
        const _id = `id-${nextId++}`;
        table(name).push({ _id, ...doc });
        return _id;
      },
      patch: async (id: string, patch: Record<string, any>) => {
        const row = Object.values(tables)
          .flat()
          .find((candidate) => candidate._id === id);
        if (!row) throw new Error(`row ${id} not found`);
        Object.assign(row, patch);
      },
      delete: async (id: string) => {
        for (const rows of Object.values(tables)) {
          const index = rows.findIndex((row) => row._id === id);
          if (index !== -1) rows.splice(index, 1);
        }
      },
    },
  };
  return { ctx, rows: (name: string) => table(name) };
}

function at(iso: string) {
  jest.spyOn(Date, "now").mockReturnValue(Date.parse(iso));
}

function teamReceipt(
  organizationId: string,
  occurredAt: string,
  netRevenueDollars: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    entity_type: "organization",
    entity_id: organizationId,
    organization_id: organizationId,
    source: "team_extra_usage",
    source_event_id: `cs_${organizationId}_${occurredAt}`,
    idempotency_key: `cs_${organizationId}_${occurredAt}`,
    gross_revenue_dollars: netRevenueDollars,
    net_revenue_dollars: netRevenueDollars,
    currency: "usd",
    occurred_at: Date.parse(occurredAt),
    attribution_strategy: "organization_pool",
    ...overrides,
  };
}

async function addTeamCredits(ctx: any, args: Record<string, unknown>) {
  const { addTeamCredits } = await import("../teamExtraUsage");
  return (addTeamCredits as any).handler(ctx, { serviceKey: "key", ...args });
}

async function backfill(ctx: any, startDay: string, endDay: string) {
  const { backfillDaily } = await import("../teamExtraUsageRevenue");
  return (backfillDaily as any).handler(ctx, { startDay, endDay });
}

async function coverage(ctx: any, startDay: string, endDay: string) {
  const { getCoverage } = await import("../teamExtraUsageRevenue");
  return (getCoverage as any).handler(ctx, { startDay, endDay });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("team extra usage revenue daily aggregate", () => {
  it("counts each organization top-up once and excludes personal and subscription revenue", async () => {
    at("2026-07-10T12:00:00.000Z");
    const { ctx, rows } = makeDb();

    await recordRevenueEventInternal(ctx, {
      entityType: "user",
      entityId: "user_a",
      userId: "user_a",
      source: "extra_usage",
      sourceEventId: "cs_personal",
      grossRevenueDollars: 20,
      attributionStrategy: "direct",
    });
    for (const [entityType, entityId] of [
      ["organization", "org_a"],
      ["user", "user_a"],
    ] as const) {
      await recordRevenueEventInternal(ctx, {
        entityType,
        entityId,
        organizationId: "org_a",
        source: "subscription",
        sourceEventId: "in_team_subscription",
        grossRevenueDollars: 200,
        attributionStrategy: "split_evenly",
      });
    }
    await addTeamCredits(ctx, {
      organizationId: "org_a",
      amountDollars: 50,
      idempotencyKey: "cs_team_a",
      stripeCheckoutSessionId: "cs_team_a",
    });
    await addTeamCredits(ctx, {
      organizationId: "org_b",
      amountDollars: 25,
      idempotencyKey: "team_auto_reload:op_1",
      revenueSource: "team_extra_usage_auto_reload",
      stripePaymentIntentId: "pi_reload",
      stripeInvoiceId: "in_reload",
    });
    const retry = await addTeamCredits(ctx, {
      organizationId: "org_a",
      amountDollars: 50,
      idempotencyKey: "cs_team_a",
      stripeCheckoutSessionId: "cs_team_a",
    });

    expect(retry.alreadyProcessed).toBe(true);
    // Only day, amount, count and write time leave the payment ledger.
    expect(rows("team_extra_usage_revenue_daily")).toEqual([
      {
        _id: expect.any(String),
        day: "2026-07-10",
        net_revenue_dollars: 75,
        revenue_event_count: 2,
        updated_at: Date.parse("2026-07-10T12:00:00.000Z"),
      },
    ]);
  });

  it("includes same-day receipts recorded before the aggregate existed", async () => {
    at("2026-07-10T12:00:00.000Z");
    const { ctx, rows } = makeDb({
      revenue_events: [teamReceipt("org_c", "2026-07-10T01:00:00.000Z", 40)],
    });

    await addTeamCredits(ctx, {
      organizationId: "org_a",
      amountDollars: 10,
      idempotencyKey: "cs_after_cutover",
    });

    expect(rows("team_extra_usage_revenue_daily")).toMatchObject([
      { day: "2026-07-10", net_revenue_dollars: 50, revenue_event_count: 2 },
    ]);
  });

  it("backfills exact totals with explicit zeros and is stable across repeated and overlapping runs", async () => {
    at("2026-07-10T12:00:00.000Z");
    const { ctx, rows } = makeDb({
      revenue_events: [
        teamReceipt("org_a", "2026-06-01T00:00:00.000Z", 50),
        teamReceipt("org_b", "2026-06-01T23:59:59.999Z", 30),
        teamReceipt("org_a", "2026-06-03T08:00:00.000Z", 20),
        teamReceipt("org_a", "2026-06-04T00:00:00.000Z", 5),
        // A duplicated receipt for the same payment counts once.
        teamReceipt("org_a", "2026-06-01T00:00:00.000Z", 50),
        // Personal revenue, including user-grain rows of this source, is
        // already in user-grain unit_economics_daily.
        teamReceipt("user_x", "2026-06-01T09:00:00.000Z", 99, {
          entity_type: "user",
          source: "extra_usage",
        }),
        teamReceipt("user_y", "2026-06-01T09:00:00.000Z", 7, {
          entity_type: "user",
        }),
      ],
      // Stale value left by an earlier partial computation.
      team_extra_usage_revenue_daily: [
        {
          day: "2026-06-03",
          net_revenue_dollars: 999,
          revenue_event_count: 9,
          updated_at: 1,
        },
      ],
    });

    expect(await backfill(ctx, "2026-06-01", "2026-06-03")).toEqual([
      expect.objectContaining({ status: "written", netRevenueDollars: 80 }),
      {
        day: "2026-06-02",
        status: "written",
        netRevenueDollars: 0,
        revenueEventCount: 0,
      },
      expect.objectContaining({ status: "written", netRevenueDollars: 20 }),
    ]);
    expect(await coverage(ctx, "2026-06-01", "2026-06-04")).toEqual({
      rows: [
        { day: "2026-06-01", netRevenueDollars: 80, revenueEventCount: 2 },
        { day: "2026-06-02", netRevenueDollars: 0, revenueEventCount: 0 },
        { day: "2026-06-03", netRevenueDollars: 20, revenueEventCount: 1 },
      ],
      missingDays: ["2026-06-04"],
    });

    const afterFirstRun = rows("team_extra_usage_revenue_daily").map((row) => ({
      ...row,
    }));
    at("2026-07-11T12:00:00.000Z");
    const repeat = await backfill(ctx, "2026-06-01", "2026-06-03");
    const overlap = await backfill(ctx, "2026-06-02", "2026-06-04");

    expect(repeat.map((day: any) => day.status)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
    ]);
    expect(overlap.map((day: any) => day.status)).toEqual([
      "unchanged",
      "unchanged",
      "written",
    ]);
    expect(rows("team_extra_usage_revenue_daily").slice(0, 3)).toEqual(
      afterFirstRun,
    );
    expect(rows("team_extra_usage_revenue_daily")).toHaveLength(4);
  });

  it("does not double count a live day when it is backfilled after cutover", async () => {
    at("2026-07-10T12:00:00.000Z");
    const { ctx } = makeDb({
      revenue_events: [teamReceipt("org_a", "2026-07-09T10:00:00.000Z", 40)],
    });
    await addTeamCredits(ctx, {
      organizationId: "org_a",
      amountDollars: 10,
      idempotencyKey: "cs_live",
    });

    // A historical day without a backfill stays unknown, not zero.
    expect(
      (await coverage(ctx, "2026-07-09", "2026-07-10")).missingDays,
    ).toEqual(["2026-07-09"]);

    at("2026-07-11T00:00:01.000Z");
    expect(await backfill(ctx, "2026-07-09", "2026-07-10")).toEqual([
      {
        day: "2026-07-09",
        status: "written",
        netRevenueDollars: 40,
        revenueEventCount: 1,
      },
      {
        day: "2026-07-10",
        status: "unchanged",
        netRevenueDollars: 10,
        revenueEventCount: 1,
      },
    ]);
  });

  it("leaves days unknown instead of publishing partial totals", async () => {
    at("2026-07-10T12:00:00.000Z");
    const crowdedDay = Array.from({ length: 251 }, (_, i) =>
      teamReceipt(`org_${i}`, "2026-06-11T10:00:00.000Z", 1),
    );
    const { ctx, rows } = makeDb({
      revenue_events: [
        teamReceipt("org_a", "2026-06-10T10:00:00.000Z", 50),
        teamReceipt("org_b", "2026-06-10T11:00:00.000Z", 40, {
          currency: "eur",
        }),
        ...crowdedDay,
      ],
      team_extra_usage_revenue_daily: [
        {
          day: "2026-06-10",
          net_revenue_dollars: 50,
          revenue_event_count: 1,
          updated_at: 1,
        },
      ],
    });

    expect(await backfill(ctx, "2026-06-10", "2026-06-11")).toEqual([
      { day: "2026-06-10", status: "unknown", reason: "non_usd_receipt" },
      { day: "2026-06-11", status: "unknown", reason: "too_many_receipts" },
    ]);
    expect(rows("team_extra_usage_revenue_daily")).toEqual([]);
  });

  it.each([
    ["before receipts were complete", "2026-05-31", "2026-06-01"],
    ["through the current UTC day", "2026-07-09", "2026-07-10"],
    ["wider than the per-call bound", "2026-06-01", "2026-07-02"],
    ["with a malformed day", "2026-6-1", "2026-06-02"],
    ["with a reversed range", "2026-06-02", "2026-06-01"],
  ])("rejects a backfill %s without writing", async (_label, start, end) => {
    at("2026-07-10T12:00:00.000Z");
    const { ctx, rows } = makeDb({
      revenue_events: [teamReceipt("org_a", "2026-06-01T10:00:00.000Z", 50)],
    });

    await expect(backfill(ctx, start, end)).rejects.toThrow();
    expect(rows("team_extra_usage_revenue_daily")).toEqual([]);
  });
});
