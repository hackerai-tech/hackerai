import { describe, expect, it } from "@jest/globals";
import { getUsageChargeBreakdown } from "../usage-charge";

describe("getUsageChargeBreakdown", () => {
  it("shows the extra-usage balance charge encoded by deducted points", () => {
    const result = getUsageChargeBreakdown({
      type: "extra",
      cost_dollars: 12.037878597222221,
      extra_usage_cost_dollars: 12.037878597222221,
      included_points_deducted: 0,
      extra_usage_points_deducted: 168_531,
    });

    expect(result.includedChargeDollars).toBe(0);
    expect(result.extraUsageChargeDollars).toBeCloseTo(19.381065);
    expect(result.totalChargeDollars).toBeCloseTo(19.381065);
  });

  it("converts included and extra point deductions independently", () => {
    const result = getUsageChargeBreakdown({
      type: "mixed",
      cost_dollars: 1.34,
      included_points_deducted: 10_000,
      extra_usage_points_deducted: 10_000,
    });

    expect(result).toEqual({
      componentBreakdownAvailable: true,
      includedChargeDollars: 1,
      extraUsageChargeDollars: 1.15,
      totalChargeDollars: 2.15,
    });
  });

  it("shows zero charge when current logs record no deducted points", () => {
    const result = getUsageChargeBreakdown({
      type: "included",
      cost_dollars: 0.25,
      included_points_deducted: 0,
      extra_usage_points_deducted: 0,
    });

    expect(result.totalChargeDollars).toBe(0);
  });

  it("preserves raw cost for legacy rows without deduction fields", () => {
    const result = getUsageChargeBreakdown({
      type: "extra",
      cost_dollars: 2.5,
      extra_usage_cost_dollars: 2.5,
    });

    expect(result).toEqual({
      componentBreakdownAvailable: true,
      includedChargeDollars: 0,
      extraUsageChargeDollars: 2.5,
      totalChargeDollars: 2.5,
    });
  });

  it("marks the component breakdown unavailable for legacy mixed rows", () => {
    const result = getUsageChargeBreakdown({
      type: "mixed",
      cost_dollars: 2.5,
    });

    expect(result).toEqual({
      componentBreakdownAvailable: false,
      includedChargeDollars: 0,
      extraUsageChargeDollars: 0,
      totalChargeDollars: 2.5,
    });
  });
});
