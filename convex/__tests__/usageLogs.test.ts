import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockApplyUnitEconomicsDelta = jest.fn();

jest.mock("../lib/serviceFunctions", () => ({
  mutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
}));

jest.mock("convex/server", () => ({
  paginationOptsValidator: "paginationOptsValidator",
}));

jest.mock("convex/values", () => ({
  v: {
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    optional: jest.fn(() => "optional"),
    boolean: jest.fn(() => "boolean"),
    union: jest.fn(() => "union"),
    literal: jest.fn(() => "literal"),
    null: jest.fn(() => "null"),
  },
}));

jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));

jest.mock("../unitEconomicsLib", () => ({
  applyUnitEconomicsDelta: mockApplyUnitEconomicsDelta,
  LEGACY_USAGE_COST_MULTIPLIER: 1.3,
  utcDay: jest.fn(() => "2026-06-17"),
}));

const createLedgerCtx = () => {
  const rows: any[] = [];
  const ctx: any = {
    db: {
      insert: jest.fn(async (_table: string, row: any) => {
        rows.push(row);
        return `usage-${rows.length}`;
      }),
      query: jest.fn(() => ({
        withIndex: jest.fn((_index: string, range: any) => {
          let settlementId: unknown;
          range({
            eq: (_field: string, value: unknown) => {
              settlementId = value;
            },
          });
          return {
            first: jest.fn(
              async () =>
                rows.find((row) => row.usage_settlement_id === settlementId) ??
                null,
            ),
          };
        }),
      })),
    },
  };
  return { ctx, rows };
};

const includedUsage = {
  serviceKey: "test-service-key",
  user_id: "user_1",
  model: "model-opus-4.6",
  type: "included",
  input_tokens: 100,
  output_tokens: 50,
  cost_dollars: 2,
  model_cost_dollars: 2,
  non_model_cost_dollars: 0,
  cost_source: "provider",
};

describe("usageLogs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("records a replayed settlement once without a second daily delta", async () => {
    const { logUsage } = await import("../usageLogs");
    const { ctx, rows } = createLedgerCtx();
    const args = { ...includedUsage, usage_settlement_id: "settlement-1" };

    await (logUsage as any).handler(ctx, args);
    await (logUsage as any).handler(ctx, args);

    expect(rows).toHaveLength(1);
    // One user-grain delta for the single recorded settlement.
    expect(mockApplyUnitEconomicsDelta).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a settlement ID is reused by another account scope", async () => {
    const { logUsage } = await import("../usageLogs");
    const { ctx, rows } = createLedgerCtx();
    await (logUsage as any).handler(ctx, {
      ...includedUsage,
      usage_settlement_id: "settlement-1",
    });

    await expect(
      (logUsage as any).handler(ctx, {
        ...includedUsage,
        usage_settlement_id: "settlement-1",
        user_id: "user_2",
      }),
    ).rejects.toThrow("already recorded for another account");
    await expect(
      (logUsage as any).handler(ctx, {
        ...includedUsage,
        usage_settlement_id: "settlement-1",
        organization_id: "org_1",
      }),
    ).rejects.toThrow("already recorded for another account");

    expect(rows).toHaveLength(1);
    expect(mockApplyUnitEconomicsDelta).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy rows without a settlement ID additive", async () => {
    const { logUsage } = await import("../usageLogs");
    const { ctx, rows } = createLedgerCtx();

    await (logUsage as any).handler(ctx, includedUsage);
    await (logUsage as any).handler(ctx, includedUsage);

    expect(ctx.db.query).not.toHaveBeenCalled();
    expect(rows).toHaveLength(2);
    expect(mockApplyUnitEconomicsDelta).toHaveBeenCalledTimes(2);
  });

  it("normalizes token-estimate split costs before persisting rollups", async () => {
    const { logUsage } = await import("../usageLogs");
    const { ctx } = createLedgerCtx();

    await (logUsage as any).handler(ctx, {
      serviceKey: "test-service-key",
      usage_settlement_id: "settlement-123",
      admission_operation_id: "admission-123",
      user_id: "user_1",
      assistant_message_id: "assistant-message-123",
      model: "model-opus-4.6",
      type: "mixed",
      input_tokens: 100,
      output_tokens: 50,
      cost_dollars: 15,
      included_cost_dollars: 6,
      extra_usage_cost_dollars: 6,
      uncovered_cost_dollars: 3,
      uncovered_points: 30000,
      usage_deduction_outcome_unknown: true,
      usage_deduction_failure_reason: "insufficient_funds",
      model_cost_dollars: 13,
      non_model_cost_dollars: 2,
      cost_source: "token_estimate",
    });

    const inserted = ctx.db.insert.mock.calls[0][1];
    expect(inserted).toMatchObject({
      usage_settlement_id: "settlement-123",
      assistant_message_id: "assistant-message-123",
      cost_dollars: 12,
      model_cost_dollars: 10,
      non_model_cost_dollars: 2,
      cost_source: "raw_token_estimate",
    });
    expect(inserted.included_cost_dollars).toBeCloseTo(4.8);
    expect(inserted.extra_usage_cost_dollars).toBeCloseTo(4.8);
    expect(inserted.uncovered_cost_dollars).toBeCloseTo(2.4);
    expect(inserted.uncovered_points).toBe(30000);
    expect(inserted.usage_deduction_failure_reason).toBe("insufficient_funds");
    expect(inserted.usage_deduction_outcome_unknown).toBe(true);
    expect(inserted.admission_operation_id).toBe("admission-123");
    expect(inserted).not.toHaveProperty("total_tokens");
    expect(inserted).not.toHaveProperty("usage_deduction_failed");

    const unitEconomicsDelta = mockApplyUnitEconomicsDelta.mock.calls[0][1];
    expect(unitEconomicsDelta).toMatchObject({
      modelCostDollars: 10,
      nonModelCostDollars: 2,
      totalTokens: 150,
    });
    expect(unitEconomicsDelta.includedUsageCostDollars).toBeCloseTo(4.8);
    expect(unitEconomicsDelta.extraUsageCostDollars).toBeCloseTo(4.8);
  });

  it("rejects mixed usage logs without a complete cost breakdown", async () => {
    const { logUsage } = await import("../usageLogs");
    const ctx: any = {
      db: {
        insert: jest.fn(async () => "usage-id"),
      },
    };

    await expect(
      (logUsage as any).handler(ctx, {
        serviceKey: "test-service-key",
        user_id: "user_1",
        model: "model-opus-4.6",
        type: "mixed",
        input_tokens: 100,
        output_tokens: 50,
        cost_dollars: 12,
        included_cost_dollars: 7.2,
        model_cost_dollars: 10,
        non_model_cost_dollars: 2,
        cost_source: "raw_token_estimate",
      }),
    ).rejects.toThrow(
      "Mixed usage logs require included and extra usage cost breakdowns",
    );

    expect(ctx.db.insert).not.toHaveBeenCalled();
    expect(mockApplyUnitEconomicsDelta).not.toHaveBeenCalled();
  });

  it("does not expose deprecated usage log inputs", async () => {
    const { logUsage } = await import("../usageLogs");

    expect((logUsage as any).args).not.toHaveProperty("total_tokens");
    expect((logUsage as any).args).not.toHaveProperty("usage_deduction_failed");
  });

  it("derives redundant display fields when reading usage logs", async () => {
    const { getUserUsageLogs } = await import("../usageLogs");
    const paginate = jest.fn(async () => ({
      page: [
        {
          _id: "usage-id",
          _creationTime: 1,
          user_id: "user_1",
          assistant_message_id: "assistant-message-123",
          model: "model-opus-4.6",
          type: "extra",
          input_tokens: 100,
          output_tokens: 50,
          cost_dollars: 1,
          uncovered_points: 25,
          usage_deduction_failure_reason: "insufficient_funds",
        },
        {
          _id: "unknown-usage-id",
          _creationTime: 2,
          model: "model-default",
          type: "extra",
          input_tokens: 0,
          output_tokens: 0,
          cost_dollars: 0,
          uncovered_points: 0,
          usage_deduction_outcome_unknown: true,
        },
      ],
      isDone: true,
      continueCursor: "",
    }));
    const ctx: any = {
      auth: {
        getUserIdentity: jest.fn(async () => ({ subject: "user_1" })),
      },
      db: {
        query: jest.fn(() => ({
          withIndex: jest.fn(() => ({
            order: jest.fn(() => ({ paginate })),
          })),
        })),
      },
    };

    const result = await (getUserUsageLogs as any).handler(ctx, {
      paginationOpts: { numItems: 10, cursor: null },
      startDate: 0,
      endDate: 10,
    });

    expect(result.page[0]).toMatchObject({
      assistant_message_id: "assistant-message-123",
      total_tokens: 150,
      usage_deduction_failed: true,
    });
    expect(result.page[1].usage_deduction_failed).toBe(true);
  });
});
