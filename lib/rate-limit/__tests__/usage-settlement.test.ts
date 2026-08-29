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

  it("does not settle cost already covered by the upfront deduction", () => {
    const state = createUsageSettlementState(baseRateLimitInfo);

    expect(
      shouldSettleUsageMidRun({
        state,
        currentCostDollars: 0.05,
      }),
    ).toBe(false);
  });

  it("settles a positive delta below the former minimum threshold", () => {
    const state = createUsageSettlementState(baseRateLimitInfo);

    expect(
      shouldSettleUsageMidRun({
        state,
        currentCostDollars: 0.08,
      }),
    ).toBe(true);
    expect(getUnsettledUsagePoints(state, 0.08)).toBe(200);
  });

  it("settles without trusting the remaining balance captured at run start", () => {
    const state = createUsageSettlementState(baseRateLimitInfo);

    expect(
      shouldSettleUsageMidRun({
        state,
        currentCostDollars: 5,
      }),
    ).toBe(true);
    expect(getUnsettledUsagePoints(state, 5)).toBe(74_000);
  });

  it("updates cumulative settled totals after a mid-run deduction", () => {
    const state = createUsageSettlementState(baseRateLimitInfo);

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

  it("settles only the new delta after an earlier step was deducted", () => {
    const state = createUsageSettlementState(baseRateLimitInfo);

    addUsageDeductionDelta(state, {
      includedPointsDeducted: 2_500,
      extraUsagePointsDeducted: 0,
      uncoveredPoints: 0,
      usageDeductionFailed: false,
    });

    expect(
      shouldSettleUsageMidRun({
        state,
        currentCostDollars: 0.3,
      }),
    ).toBe(true);
    expect(getUnsettledUsagePoints(state, 0.3)).toBe(1_000);

    expect(
      shouldSettleUsageMidRun({
        state,
        currentCostDollars: 0.4,
      }),
    ).toBe(true);
    expect(getUnsettledUsagePoints(state, 0.4)).toBe(2_500);
  });

  it("normalizes Extra Usage points before calculating the unsettled delta", () => {
    const state = createUsageSettlementState({
      ...baseRateLimitInfo,
      pointsDeducted: 0,
      extraUsagePointsDeducted: 700,
    });

    // 700 stored Extra Usage points cover 750 included-usage pricing points.
    expect(getUnsettledUsagePoints(state, 0.05)).toBe(0);
    expect(getUnsettledUsagePoints(state, 0.06)).toBe(150);
  });
});
