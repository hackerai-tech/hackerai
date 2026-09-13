import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockApplyUnitEconomicsDelta = jest.fn();

jest.mock("../_generated/server", () => ({
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

describe("usageLogs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("normalizes token-estimate split costs before persisting rollups", async () => {
    const { logUsage } = await import("../usageLogs");
    const ctx: any = {
      db: {
        insert: jest.fn(async () => "usage-id"),
      },
    };

    await (logUsage as any).handler(ctx, {
      serviceKey: "test-service-key",
      usage_settlement_id: "settlement-123",
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
  });
});
