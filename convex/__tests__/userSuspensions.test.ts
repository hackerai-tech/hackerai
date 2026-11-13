import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

jest.mock("../lib/serviceFunctions", () => ({
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
    | "dispute_billing_hold"
    | "support_confirmed_fraud"
    | "security_abuse";
  source: "stripe" | "support";
  source_id: string;
  source_reason?: string;
  stripe_customer_id?: string;
  stripe_charge_id?: string;
  workos_organization_id?: string;
  created_at: number;
  updated_at: number;
  source_created_at?: number;
  resolved_at?: number;
  resolved_reason?: string;
};

type TokenRow = {
  _id: string;
  user_id: string;
  token: string;
  revoked_at?: number;
};

function makeMockCtx(
  initialRows: SuspensionRow[] = [],
  initialTokens: TokenRow[] = [],
) {
  const rows = [...initialRows];
  const tokens = [...initialTokens];
  const tables: Record<string, any[]> = {
    user_suspensions: rows,
    local_sandbox_tokens: tokens,
  };

  const matchesFilters = (row: any, filters: Record<string, unknown>) =>
    Object.entries(filters).every(([field, value]) => row[field] === value);

  // Records index use; the table-specific reader below applies the filters.
  const withIndex = jest.fn((_indexName: string, _predicate: any) => {});
  const indexed = (table: string) => (indexName: string, predicate: any) => {
    withIndex(indexName, predicate);
    const filters: Record<string, unknown> = {};
    const q = {
      eq: jest.fn((field: string, value: unknown) => {
        filters[field] = value;
        return q;
      }),
    };
    predicate(q);

    const filteredRows = () =>
      tables[table].filter((row) => matchesFilters(row, filters));

    return {
      order: jest.fn((direction: "asc" | "desc") => ({
        collect: async () => {
          const sorted = [...filteredRows()].sort(
            (a, b) => (a.source_created_at ?? 0) - (b.source_created_at ?? 0),
          );
          if (direction === "desc") sorted.reverse();
          return sorted;
        },
        first: async () => {
          const sorted = [...filteredRows()].sort(
            (a, b) => (a.source_created_at ?? 0) - (b.source_created_at ?? 0),
          );
          if (direction === "desc") sorted.reverse();
          return sorted[0] ?? null;
        },
      })),
      first: async () => filteredRows()[0] ?? null,
      take: async (count: number) => filteredRows().slice(0, count),
    };
  };

  const ctx: any = {
    __withIndex: withIndex,
    db: {
      query: jest.fn((table: string) => ({
        withIndex: indexed(table),
      })),
      delete: jest.fn(async (id: string) => {
        for (const list of Object.values(tables)) {
          const index = list.findIndex((row) => row._id === id);
          if (index >= 0) list.splice(index, 1);
        }
      }),
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

  return { ctx, rows, tokens };
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

  it("creates a support-confirmed fraud suspension with an honest source", async () => {
    const { upsertActive } = await import("../userSuspensions");
    const { ctx, rows } = makeMockCtx();

    const id = await (upsertActive as any).handler(ctx, {
      ...baseArgs,
      category: "support_confirmed_fraud",
      source: "support",
      sourceId: "support_case:intercom_456",
      sourceReason: "confirmed_unauthorized_charge",
    });

    expect(id).toBe("id-1");
    expect(rows[0]).toMatchObject({
      category: "support_confirmed_fraud",
      source: "support",
      source_id: "support_case:intercom_456",
      source_reason: "confirmed_unauthorized_charge",
    });
  });

  it("persists a security suspension that survives login and is resolved only by support", async () => {
    const {
      upsertActive,
      getActiveByUser,
      getActiveChatAccessBlockByUser,
      resolveBySource,
    } = await import("../userSuspensions");
    const { ctx, rows } = makeMockCtx();
    const args = {
      ...baseArgs,
      stripeCustomerId: undefined,
      category: "security_abuse",
      source: "support",
      sourceId: "abuse_case_123",
    };
    await (upsertActive as any).handler(ctx, args);
    const queryArgs = { serviceKey: SERVICE_KEY, userId: args.userId };
    expect(
      await (getActiveByUser as any).handler(ctx, queryArgs),
    ).toMatchObject({ category: "security_abuse", status: "active" });
    expect(
      await (getActiveChatAccessBlockByUser as any).handler(ctx, queryArgs),
    ).toMatchObject({ category: "security_abuse" });
    await (resolveBySource as any).handler(ctx, {
      ...queryArgs,
      sourceId: args.sourceId,
      resolvedReason: "support_review",
    });
    expect(await (getActiveByUser as any).handler(ctx, queryArgs)).toBeNull();
    expect(rows).toHaveLength(1);
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

  it("returns an active fraud dispute even when another suspension is newer", async () => {
    const { getActiveFraudDisputeByUser } = await import("../userSuspensions");
    const { ctx } = makeMockCtx([
      {
        _id: "id-1",
        user_id: "user_123",
        status: "active",
        category: "dispute_fraudulent",
        source: "stripe",
        source_id: "dp_fraud",
        stripe_customer_id: "cus_123",
        created_at: 1_000,
        updated_at: 1_000,
        source_created_at: 1_000,
      },
      {
        _id: "id-2",
        user_id: "user_123",
        status: "active",
        category: "dispute_billing_hold",
        source: "stripe",
        source_id: "dp_billing_newer",
        stripe_customer_id: "cus_123",
        created_at: 2_000,
        updated_at: 2_000,
        source_created_at: 9_000,
      },
      {
        _id: "id-3",
        user_id: "user_123",
        status: "resolved",
        category: "dispute_fraudulent",
        source: "stripe",
        source_id: "dp_resolved",
        stripe_customer_id: "cus_123",
        created_at: 3_000,
        updated_at: 3_000,
        source_created_at: 10_000,
      },
    ]);

    const result = await (getActiveFraudDisputeByUser as any).handler(ctx, {
      serviceKey: SERVICE_KEY,
      userId: "user_123",
    });

    expect(result.source_id).toBe("dp_fraud");
    expect(ctx.__withIndex).toHaveBeenCalledWith(
      "by_user_status_category_source_created",
      expect.any(Function),
    );
  });

  it("returns the newest active chat-access block from Stripe or support", async () => {
    const { getActiveChatAccessBlockByUser } =
      await import("../userSuspensions");
    const { ctx } = makeMockCtx([
      {
        _id: "id-1",
        user_id: "user_123",
        status: "active",
        category: "dispute_fraudulent",
        source: "stripe",
        source_id: "dp_fraud",
        stripe_customer_id: "cus_123",
        created_at: 1_000,
        updated_at: 1_000,
        source_created_at: 1_000,
      },
      {
        _id: "id-2",
        user_id: "user_123",
        status: "active",
        category: "support_confirmed_fraud",
        source: "support",
        source_id: "support_case:intercom_456",
        stripe_customer_id: "cus_123",
        created_at: 2_000,
        updated_at: 2_000,
        source_created_at: 9_000,
      },
      {
        _id: "id-3",
        user_id: "user_123",
        status: "active",
        category: "dispute_billing_hold",
        source: "stripe",
        source_id: "dp_billing_newer",
        stripe_customer_id: "cus_123",
        created_at: 3_000,
        updated_at: 3_000,
        source_created_at: 10_000,
      },
    ]);

    const result = await (getActiveChatAccessBlockByUser as any).handler(ctx, {
      serviceKey: SERVICE_KEY,
      userId: "user_123",
    });

    expect(result.source_id).toBe("support_case:intercom_456");
    expect(ctx.__withIndex).toHaveBeenCalledWith(
      "by_user_status_category_source_created",
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

  describe("abuse local-access revocation", () => {
    const suspension = (
      source_id: string,
      category: SuspensionRow["category"],
      status: SuspensionRow["status"] = "active",
    ): SuspensionRow => ({
      _id: source_id,
      user_id: "user_123",
      status,
      category,
      source: category === "security_abuse" ? "support" : "stripe",
      source_id,
      created_at: 1_000,
      updated_at: 1_000,
    });
    const markers = (): TokenRow[] => [
      {
        _id: "marker",
        user_id: "user_123",
        token: "revoked_synthetic",
        revoked_at: 2_000,
      },
      {
        _id: "other-marker",
        user_id: "other_user",
        token: "revoked_synthetic_other",
        revoked_at: 2_000,
      },
    ];
    const resolve = async (ctx: any, sourceId: string) => {
      const { resolveBySource } = await import("../userSuspensions");
      return (resolveBySource as any).handler(ctx, {
        serviceKey: SERVICE_KEY,
        userId: "user_123",
        sourceId,
        resolvedReason: "support_review",
      });
    };

    it("lifts the block when the last independent security restriction outlived the case", async () => {
      // The case already released its own restriction but kept the marker.
      const { ctx, rows, tokens } = makeMockCtx(
        [
          suspension("abuse-late:case", "security_abuse", "resolved"),
          suspension("independent", "security_abuse"),
          suspension("billing", "dispute_billing_hold"),
        ],
        markers(),
      );

      await resolve(ctx, "independent");

      expect(tokens.map((row) => row._id)).toEqual(["other-marker"]);
      expect(rows.map((row) => [row.source_id, row.status])).toEqual([
        ["abuse-late:case", "resolved"],
        ["independent", "resolved"],
        ["billing", "active"],
      ]);
    });

    it.each([
      ["another security restriction remains", "independent", true],
      ["a billing restriction is resolved", "billing", false],
    ])(
      "keeps the block when %s",
      async (_label, resolvedSource, secondSecurity) => {
        const { ctx, tokens } = makeMockCtx(
          [
            suspension("independent", "security_abuse"),
            ...(secondSecurity ? [suspension("second", "security_abuse")] : []),
            suspension("billing", "dispute_billing_hold"),
          ],
          markers(),
        );

        await resolve(ctx, resolvedSource);

        expect(tokens.map((row) => row._id)).toEqual([
          "marker",
          "other-marker",
        ]);
      },
    );
  });
});
