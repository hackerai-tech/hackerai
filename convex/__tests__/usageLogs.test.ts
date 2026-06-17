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
      user_id: "user_1",
      model: "model-sonnet-4.6",
      type: "mixed",
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      cost_dollars: 15,
      included_cost_dollars: 9,
      extra_usage_cost_dollars: 6,
      model_cost_dollars: 13,
      non_model_cost_dollars: 2,
      cost_source: "token_estimate",
    });

    const inserted = ctx.db.insert.mock.calls[0][1];
    expect(inserted).toMatchObject({
      cost_dollars: 12,
      model_cost_dollars: 10,
      non_model_cost_dollars: 2,
      cost_source: "raw_token_estimate",
    });
    expect(inserted.included_cost_dollars).toBeCloseTo(7.2);
    expect(inserted.extra_usage_cost_dollars).toBeCloseTo(4.8);

    const unitEconomicsDelta = mockApplyUnitEconomicsDelta.mock.calls[0][1];
    expect(unitEconomicsDelta).toMatchObject({
      modelCostDollars: 10,
      nonModelCostDollars: 2,
    });
    expect(unitEconomicsDelta.includedUsageCostDollars).toBeCloseTo(7.2);
    expect(unitEconomicsDelta.extraUsageCostDollars).toBeCloseTo(4.8);
  });
});
