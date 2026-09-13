import {
  EXTRA_USAGE_POINTS_PER_DOLLAR,
  extraUsagePointsToDollars,
} from "@/convex/lib/extraUsagePricing";

export type UsageLogBilling = {
  type: "included" | "extra" | "mixed";
  cost_dollars: number;
  included_cost_dollars?: number;
  extra_usage_cost_dollars?: number;
  included_points_deducted?: number;
  extra_usage_points_deducted?: number;
};

const nonNegativePoints = (points: number | undefined): number =>
  Number.isFinite(points) ? Math.max(0, points ?? 0) : 0;

export const getUsageChargeBreakdown = (log: UsageLogBilling) => {
  const hasDeductionData =
    typeof log.included_points_deducted === "number" ||
    typeof log.extra_usage_points_deducted === "number";

  if (hasDeductionData) {
    const includedChargeDollars =
      nonNegativePoints(log.included_points_deducted) /
      EXTRA_USAGE_POINTS_PER_DOLLAR;
    const extraUsageChargeDollars = extraUsagePointsToDollars(
      nonNegativePoints(log.extra_usage_points_deducted),
    );

    return {
      componentBreakdownAvailable: true,
      includedChargeDollars,
      extraUsageChargeDollars,
      totalChargeDollars: includedChargeDollars + extraUsageChargeDollars,
    };
  }

  const componentBreakdownAvailable =
    log.type !== "mixed" ||
    (typeof log.included_cost_dollars === "number" &&
      typeof log.extra_usage_cost_dollars === "number");

  const includedChargeDollars =
    log.included_cost_dollars ??
    (log.type === "included" ? log.cost_dollars : 0);
  const extraUsageChargeDollars =
    log.extra_usage_cost_dollars ??
    (log.type === "extra" ? log.cost_dollars : 0);

  return {
    componentBreakdownAvailable,
    includedChargeDollars,
    extraUsageChargeDollars,
    totalChargeDollars: log.cost_dollars,
  };
};
