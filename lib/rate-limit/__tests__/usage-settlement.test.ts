import { describe, expect, it } from "@jest/globals";
import {
  addUsageDeductionDelta,
  createUsageSettlementState,
  getUnsettledUsagePoints,
  shouldSettleUsageMidRun,
} from "../usage-settlement";

describe("usage-settlement", () => {
  const baseRateLimitInfo = {
    remaining: 100_000,
    resetTime: new Date(),
    limit: 250_000,
    pointsDeducted: 1_000,
  };

  it("does not settle small deltas while known balance can cover the run", () => {
    const state = createUsageSettlementState(baseRateLimitInfo, {
      enabled: true,
      hasBalance: true,
      balanceDollars: 10,
    });

    expect(
      shouldSettleUsageMidRun({
        state,
        currentCostDollars: 0.25,
      }),
    ).toBe(false);
  });

  it("does not settle larger deltas while included monthly cushion can cover them", () => {
    const state = createUsageSettlementState(baseRateLimitInfo, {
      enabled: true,
      hasBalance: false,
      balanceDollars: 0,
    });

    expect(
      shouldSettleUsageMidRun({
        state,
        currentCostDollars: 5,
      }),
    ).toBe(false);
  });

  it("settles when accumulated cost exceeds known included and extra balance cushion", () => {
    const state = createUsageSettlementState(
      {
        ...baseRateLimitInfo,
        remaining: 0,
        monthly: {
          remaining: 0,
          limit: 250_000,
          resetTime: new Date(),
        },
      },
      {
        enabled: true,
        hasBalance: true,
        balanceDollars: 0.57,
      },
    );

    expect(
      shouldSettleUsageMidRun({
        state,
        currentCostDollars: 8.71,
      }),
    ).toBe(true);
    expect(getUnsettledUsagePoints(state, 8.71)).toBe(86_100);
  });

  it("updates cumulative settled totals after a mid-run deduction", () => {
    const state = createUsageSettlementState(baseRateLimitInfo, {
      enabled: true,
      hasBalance: true,
      balanceDollars: 1,
    });

    const cumulative = addUsageDeductionDelta(state, {
      includedPointsDeducted: 2_000,
      extraUsagePointsDeducted: 3_000,
      uncoveredPoints: 500,
      usageDeductionFailed: true,
      usageDeductionFailureReason: "insufficient_funds",
    });

    expect(cumulative).toEqual({
      includedPointsDeducted: 3_000,
      extraUsagePointsDeducted: 3_000,
      uncoveredPoints: 500,
      usageDeductionFailed: true,
      usageDeductionFailureReason: "insufficient_funds",
    });
  });

  it("subtracts initial and mid-run extra usage from known monthly cap cushion", () => {
    const state = createUsageSettlementState(
      {
        ...baseRateLimitInfo,
        remaining: 0,
        monthly: {
          remaining: 0,
          limit: 250_000,
          resetTime: new Date(),
        },
        extraUsagePointsDeducted: 2_000,
      },
      {
        enabled: true,
        hasBalance: true,
        balanceDollars: 2,
        monthlyRemainingDollars: 0.9,
      },
    );

    addUsageDeductionDelta(state, {
      includedPointsDeducted: 0,
      extraUsagePointsDeducted: 3_000,
      uncoveredPoints: 0,
      usageDeductionFailed: false,
    });

    expect(
      shouldSettleUsageMidRun({
        state,
        currentCostDollars: 1.2,
      }),
    ).toBe(true);
  });
});
