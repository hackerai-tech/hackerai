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
  internalMutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
}));

jest.mock("convex/values", () => ({
  v: new Proxy(
    {},
    {
      get: () => jest.fn(() => "validator"),
    },
  ),
}));

jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));

jest.mock("../lib/logger", () => ({
  convexLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockRecordRevenueEventInternal = jest.fn(async () => ({
  alreadyRecorded: false,
}));

jest.mock("../unitEconomicsLib", () => ({
  recordRevenueEventInternal: mockRecordRevenueEventInternal,
}));

type Row = { _id: string; [key: string]: any };
type Tables = Record<string, Row[]>;

const SERVICE_KEY = "service_key";
const INDEX_FIELDS: Record<string, Record<string, string[]>> = {
  extra_usage: {
    by_user_id: ["user_id"],
  },
  extra_usage_purchases: {
    by_stripe_checkout_session_id: ["stripe_checkout_session_id"],
  },
  processed_checkout_sessions: {
    by_session_key: ["session_key"],
  },
  processed_webhooks: {
    by_event_id: ["event_id"],
  },
};

function createQueryResult(rows: Row[]) {
  return {
    first: jest.fn(async () => rows[0] ?? null),
    unique: jest.fn(async () => {
      if (rows.length > 1) {
        throw new Error(`Expected one row, found ${rows.length}`);
      }
      return rows[0] ?? null;
    }),
  };
}

function createQueryBuilder(tables: Tables, table: string) {
  const tableRows = () => tables[table] ?? [];
  const filterRows = (filters: Array<{ field: string; value: any }>) =>
    tableRows().filter((row) =>
      filters.every(({ field, value }) => row[field] === value),
    );

  return {
    withIndex: jest.fn((indexName: string, build: (q: any) => any) => {
      const expectedFields = INDEX_FIELDS[table]?.[indexName];
      expect(expectedFields).toBeDefined();

      const filters: Array<{ field: string; value: any }> = [];
      const q = {
        eq: (field: string, value: any) => {
          expect(field).toBe(expectedFields![filters.length]);
          filters.push({ field, value });
          return q;
        },
      };
      build(q);
      expect(filters.map(({ field }) => field)).toEqual(expectedFields);
      return createQueryResult(filterRows(filters));
    }),
  };
}

function createMockCtx(initialTables: Partial<Tables> = {}) {
  const tables: Tables = {
    extra_usage: [],
    extra_usage_purchases: [],
    processed_checkout_sessions: [],
    processed_webhooks: [],
    ...initialTables,
  };

  const db = {
    query: jest.fn((table: string) => createQueryBuilder(tables, table)),
    insert: jest.fn(async (table: string, doc: Record<string, any>) => {
      const row = { _id: `${table}-${tables[table]?.length ?? 0}`, ...doc };
      tables[table] ??= [];
      tables[table].push(row);
      return row._id;
    }),
    patch: jest.fn(async (id: string, patch: Record<string, any>) => {
      for (const rows of Object.values(tables)) {
        const row = rows.find((candidate) => candidate._id === id);
        if (!row) continue;
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) {
            delete row[key];
          } else {
            row[key] = value;
          }
        }
      }
    }),
  };

  return { ctx: { db }, tables, db };
}

async function callRecordPurchaseCreated(ctx: any) {
  const { recordPurchaseCreated } = await import("../extraUsage");
  return (recordPurchaseCreated as any).handler(ctx, {
    userId: "user_123",
    amountDollars: 50,
    stripeCheckoutSessionId: "cs_test",
  });
}

async function callRecordPurchaseFailed(ctx: any) {
  const { recordPurchaseFailed } = await import("../extraUsage");
  return (recordPurchaseFailed as any).handler(ctx, {
    serviceKey: SERVICE_KEY,
    userId: "user_123",
    amountDollars: 50,
    stripeCheckoutSessionId: "cs_test",
    stripePaymentIntentId: "pi_test",
    stripeInvoiceId: "in_test",
    route: "webhook",
    lastError: "serviceKey: secret-value\nsecond line",
  });
}

async function callAddCredits(ctx: any) {
  const { addCredits } = await import("../extraUsage");
  return (addCredits as any).handler(ctx, {
    serviceKey: SERVICE_KEY,
    userId: "user_123",
    amountDollars: 50,
    idempotencyKey: "cs_cs_test",
    legacyIdempotencyKey: "evt_test",
    revenueSource: "extra_usage_purchase",
    stripeCustomerId: "cus_test",
    stripeCheckoutSessionId: "cs_test",
    stripePaymentIntentId: "pi_test",
    stripeInvoiceId: "in_test",
    purchaseRoute: "confirm",
  });
}

describe("extra usage purchase ledger", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, "now").mockReturnValue(1_000_000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("records a created purchase row at Checkout session creation", async () => {
    const { ctx, tables } = createMockCtx();

    await callRecordPurchaseCreated(ctx);

    expect(tables.extra_usage_purchases).toHaveLength(1);
    expect(tables.extra_usage_purchases[0]).toMatchObject({
      user_id: "user_123",
      amount_dollars: 50,
      stripe_checkout_session_id: "cs_test",
      status: "created",
      last_route: "checkout_action",
      last_result: "created",
      created_at: 1_000_000,
      updated_at: 1_000_000,
    });
  });

  it("marks a newly credited purchase after balance and revenue writes succeed", async () => {
    const { ctx, tables } = createMockCtx({
      extra_usage_purchases: [
        {
          _id: "purchase-1",
          user_id: "user_123",
          amount_dollars: 50,
          stripe_checkout_session_id: "cs_test",
          status: "paid_seen",
          last_route: "confirm",
          last_result: "paid_seen",
          created_at: 900_000,
          updated_at: 900_000,
        },
      ],
    });

    const result = await callAddCredits(ctx);

    expect(result).toEqual({ newBalance: 50, alreadyProcessed: false });
    expect(tables.extra_usage).toMatchObject([
      {
        user_id: "user_123",
        balance_points: 500_000,
        updated_at: 1_000_000,
      },
    ]);
    expect(tables.processed_checkout_sessions).toMatchObject([
      { session_key: "cs_cs_test", processed_at: 1_000_000 },
    ]);
    expect(tables.processed_webhooks).toMatchObject([
      { event_id: "cs_cs_test", processed_at: 1_000_000 },
    ]);
    expect(tables.extra_usage_purchases[0]).toMatchObject({
      status: "credited",
      last_route: "confirm",
      last_result: "credited",
      stripe_payment_intent_id: "pi_test",
      stripe_invoice_id: "in_test",
      credited_at: 1_000_000,
      updated_at: 1_000_000,
    });
    expect(mockRecordRevenueEventInternal).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        source: "extra_usage",
        stripeCheckoutSessionId: "cs_test",
        stripePaymentIntentId: "pi_test",
        stripeInvoiceId: "in_test",
        grossRevenueDollars: 50,
      }),
    );
  });

  it("marks duplicate Checkout sessions as credited but already processed", async () => {
    const { ctx, tables } = createMockCtx({
      extra_usage: [
        {
          _id: "extra-1",
          user_id: "user_123",
          balance_points: 1_000,
          updated_at: 900_000,
        },
      ],
      extra_usage_purchases: [
        {
          _id: "purchase-1",
          user_id: "user_123",
          amount_dollars: 50,
          stripe_checkout_session_id: "cs_test",
          status: "paid_seen",
          created_at: 900_000,
          updated_at: 900_000,
        },
      ],
      processed_checkout_sessions: [
        {
          _id: "processed-1",
          session_key: "cs_cs_test",
          processed_at: 950_000,
        },
      ],
    });

    const result = await callAddCredits(ctx);

    expect(result).toEqual({ newBalance: 0, alreadyProcessed: true });
    expect(tables.extra_usage[0].balance_points).toBe(1_000);
    expect(tables.extra_usage_purchases[0]).toMatchObject({
      status: "credited",
      last_route: "confirm",
      last_result: "already_processed",
      credited_at: 950_000,
    });
    expect(mockRecordRevenueEventInternal).not.toHaveBeenCalled();
  });

  it("records sanitized failed credit attempts without sensitive error text", async () => {
    const { ctx, tables } = createMockCtx({
      extra_usage_purchases: [
        {
          _id: "purchase-1",
          user_id: "user_123",
          amount_dollars: 50,
          stripe_checkout_session_id: "cs_test",
          status: "paid_seen",
          created_at: 900_000,
          updated_at: 900_000,
        },
      ],
    });

    await callRecordPurchaseFailed(ctx);

    expect(tables.extra_usage_purchases[0]).toMatchObject({
      status: "failed",
      last_route: "webhook",
      last_result: "failed",
      stripe_payment_intent_id: "pi_test",
      stripe_invoice_id: "in_test",
      last_error: "serviceKey: [redacted]",
      updated_at: 1_000_000,
    });
  });
});
