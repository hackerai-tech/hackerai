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
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    optional: jest.fn(() => "optional"),
    union: jest.fn(() => "union"),
    literal: jest.fn(() => "literal"),
  },
}));

jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));

const SERVICE_KEY = "test-service-key";

type SuspensionRow = {
  _id: string;
  user_id: string;
  status: "active" | "resolved";
  category:
    | "early_fraud_warning"
    | "dispute_fraudulent"
    | "dispute_billing_hold";
  source: "stripe";
  source_id: string;
  source_reason?: string;
  stripe_customer_id: string;
  stripe_charge_id?: string;
  workos_organization_id?: string;
  created_at: number;
  updated_at: number;
  source_created_at?: number;
  resolved_at?: number;
  resolved_reason?: string;
};

function makeMockCtx(initialRows: SuspensionRow[] = []) {
  const rows = [...initialRows];

  const matchesFilters = (
    row: SuspensionRow,
    filters: Record<string, unknown>,
  ) =>
    Object.entries(filters).every(
      ([field, value]) => row[field as keyof SuspensionRow] === value,
    );

  const withIndex = jest.fn((_indexName: string, predicate: any) => {
    const filters: Record<string, unknown> = {};
    const q = {
      eq: jest.fn((field: string, value: unknown) => {
        filters[field] = value;
        return q;
      }),
    };
    predicate(q);

    const filteredRows = () =>
      rows.filter((row) => matchesFilters(row, filters));

    return {
      order: jest.fn((direction: "asc" | "desc") => ({
        first: async () => {
          const sorted = [...filteredRows()].sort(
            (a, b) => (a.source_created_at ?? 0) - (b.source_created_at ?? 0),
          );
          if (direction === "desc") sorted.reverse();
          return sorted[0] ?? null;
        },
      })),
      first: async () => filteredRows()[0] ?? null,
    };
  });

  const ctx: any = {
    __withIndex: withIndex,
    db: {
      query: jest.fn(() => ({
        withIndex,
      })),
      insert: jest.fn(
        async (_table: string, doc: Omit<SuspensionRow, "_id">) => {
          const row: SuspensionRow = { _id: `id-${rows.length + 1}`, ...doc };
          rows.push(row);
          return row._id;
        },
      ),
      patch: jest.fn(async (id: string, patch: Partial<SuspensionRow>) => {
        const row = rows.find((r) => r._id === id);
        if (!row) throw new Error(`row ${id} not found`);
        Object.assign(row, patch);
      }),
    },
  };

  return { ctx, rows };
}

const baseArgs = {
  serviceKey: SERVICE_KEY,
  userId: "user_123",
  category: "dispute_fraudulent" as const,
  sourceId: "dp_123",
  sourceReason: "fraudulent",
  stripeCustomerId: "cus_123",
  stripeChargeId: "ch_123",
  workosOrganizationId: "org_123",
  sourceCreatedAt: 1_000,
};

describe("userSuspensions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, "now").mockReturnValue(10_000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("creates an active suspension", async () => {
    const { upsertActive } = await import("../userSuspensions");
    const { ctx, rows } = makeMockCtx();

    const id = await (upsertActive as any).handler(ctx, baseArgs);

    expect(id).toBe("id-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: "user_123",
      status: "active",
      category: "dispute_fraudulent",
      source: "stripe",
      source_id: "dp_123",
      stripe_customer_id: "cus_123",
      created_at: 10_000,
      updated_at: 10_000,
      source_created_at: 1_000,
    });
  });

  it("updates an existing suspension for the same user and source", async () => {
    const { upsertActive } = await import("../userSuspensions");
    const { ctx, rows } = makeMockCtx([
      {
        _id: "id-1",
        user_id: "user_123",
        status: "resolved",
        category: "early_fraud_warning",
        source: "stripe",
        source_id: "dp_123",
        stripe_customer_id: "cus_old",
        created_at: 5_000,
        updated_at: 5_000,
        resolved_at: 8_000,
        resolved_reason: "manual",
      },
    ]);

    const id = await (upsertActive as any).handler(ctx, baseArgs);

    expect(id).toBe("id-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "active",
      category: "dispute_fraudulent",
      stripe_customer_id: "cus_123",
      created_at: 5_000,
      updated_at: 10_000,
      resolved_at: undefined,
      resolved_reason: undefined,
    });
  });

  it("returns the newest active suspension for a user", async () => {
    const { getActiveByUser } = await import("../userSuspensions");
    const { ctx } = makeMockCtx([
      {
        _id: "id-1",
        user_id: "user_123",
        status: "active",
        category: "early_fraud_warning",
        source: "stripe",
        source_id: "issfr_older",
        stripe_customer_id: "cus_123",
        created_at: 1_000,
        updated_at: 1_000,
        source_created_at: 1_000,
      },
      {
        _id: "id-2",
        user_id: "user_123",
        status: "resolved",
        category: "dispute_fraudulent",
        source: "stripe",
        source_id: "dp_resolved",
        stripe_customer_id: "cus_123",
        created_at: 5_000,
        updated_at: 5_000,
        source_created_at: 5_000,
      },
      {
        _id: "id-3",
        user_id: "user_123",
        status: "active",
        category: "dispute_billing_hold",
        source: "stripe",
        source_id: "dp_newer",
        stripe_customer_id: "cus_123",
        created_at: 2_000,
        updated_at: 2_000,
        source_created_at: 9_000,
      },
    ]);

    const result = await (getActiveByUser as any).handler(ctx, {
      serviceKey: SERVICE_KEY,
      userId: "user_123",
    });

    expect(result.source_id).toBe("dp_newer");
    expect(ctx.__withIndex).toHaveBeenCalledWith(
      "by_user_status_source_created",
      expect.any(Function),
    );
  });

  it("resolves by source so the suspension is no longer active", async () => {
    const { resolveBySource, getActiveByUser } =
      await import("../userSuspensions");
    const { ctx, rows } = makeMockCtx([
      {
        _id: "id-1",
        user_id: "user_123",
        status: "active",
        category: "dispute_billing_hold",
        source: "stripe",
        source_id: "dp_123",
        stripe_customer_id: "cus_123",
        created_at: 1_000,
        updated_at: 1_000,
      },
    ]);

    const result = await (resolveBySource as any).handler(ctx, {
      serviceKey: SERVICE_KEY,
      userId: "user_123",
      sourceId: "dp_123",
      resolvedReason: "support_review",
    });

    expect(result).toEqual({ resolved: true });
    expect(rows[0]).toMatchObject({
      status: "resolved",
      resolved_at: 10_000,
      resolved_reason: "support_review",
      updated_at: 10_000,
    });

    const active = await (getActiveByUser as any).handler(ctx, {
      serviceKey: SERVICE_KEY,
      userId: "user_123",
    });
    expect(active).toBeNull();
  });
});
