import type { RateLimitInfo, SubscriptionTier } from "@/types";
import type { UsageRefundTracker } from "./refund";
import {
  billableCostDollarsToPoints,
  deductUsage,
  extraUsagePointsToIncludedPoints,
  type UsageDeductionFailureReason,
  type UsageDeductionResult,
} from "./token-bucket";

export type UsageSettlementState = {
  usageDeductionOutcomeUnknown?: boolean;
  includedPointsDeducted: number;
  extraUsagePointsDeducted: number;
  uncoveredPoints: number;
  usageDeductionFailed: boolean;
  usageDeductionFailureReason?: UsageDeductionFailureReason;
};

const nonNegativePoints = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;

export const createUsageSettlementState = (
  rateLimitInfo: RateLimitInfo,
): UsageSettlementState => {
  return {
    includedPointsDeducted: nonNegativePoints(rateLimitInfo.pointsDeducted),
    extraUsagePointsDeducted: nonNegativePoints(
      rateLimitInfo.extraUsagePointsDeducted,
    ),
    uncoveredPoints: 0,
    usageDeductionFailed: false,
  };
};

export const getUsageSettlementInitialDeduction = (
  state: UsageSettlementState,
): Pick<RateLimitInfo, "pointsDeducted" | "extraUsagePointsDeducted"> & {
  usageDeductionOutcomeUnknown?: boolean;
} => ({
  pointsDeducted: state.includedPointsDeducted,
  extraUsagePointsDeducted: state.extraUsagePointsDeducted,
  ...(state.usageDeductionOutcomeUnknown && {
    usageDeductionOutcomeUnknown: true,
  }),
});

export const getSettledUsagePoints = (state: UsageSettlementState): number =>
  state.includedPointsDeducted +
  extraUsagePointsToIncludedPoints(state.extraUsagePointsDeducted);

export const getUnsettledUsagePoints = (
  state: UsageSettlementState,
  currentCostDollars: number,
): number =>
  Math.max(
    0,
    Math.ceil(
      billableCostDollarsToPoints(currentCostDollars) -
        getSettledUsagePoints(state),
    ),
  );

// Settle every newly accrued model-step delta. A balance captured when the run
// started is not a safe cushion because another parallel run can spend it.
export const shouldSettleUsageMidRun = ({
  state,
  currentCostDollars,
}: {
  state: UsageSettlementState;
  currentCostDollars: number;
  force?: boolean;
}): boolean =>
  !state.usageDeductionOutcomeUnknown &&
  getUnsettledUsagePoints(state, currentCostDollars) > 0;

export const addUsageDeductionDelta = (
  state: UsageSettlementState,
  result: UsageDeductionResult,
): UsageDeductionResult => {
  if (result.usageDeductionOutcomeUnknown)
    state.usageDeductionOutcomeUnknown = true;
  state.includedPointsDeducted += nonNegativePoints(
    result.includedPointsDeducted,
  );
  state.extraUsagePointsDeducted += nonNegativePoints(
    result.extraUsagePointsDeducted,
  );
  state.uncoveredPoints += nonNegativePoints(result.uncoveredPoints);
  state.usageDeductionFailed =
    state.usageDeductionFailed || result.usageDeductionFailed;
  if (result.usageDeductionFailureReason) {
    state.usageDeductionFailureReason = result.usageDeductionFailureReason;
  }
  return {
    includedPointsDeducted: state.includedPointsDeducted,
    extraUsagePointsDeducted: state.extraUsagePointsDeducted,
    uncoveredPoints: state.uncoveredPoints,
    usageDeductionFailed: state.usageDeductionFailed,
    ...(state.usageDeductionOutcomeUnknown && {
      usageDeductionOutcomeUnknown: true,
    }),
    ...(state.usageDeductionFailureReason && {
      usageDeductionFailureReason: state.usageDeductionFailureReason,
    }),
  };
};

export const replaceUsageSettlementState = (
  state: UsageSettlementState,
  cumulativeResult: UsageDeductionResult,
): void => {
  if (cumulativeResult.usageDeductionOutcomeUnknown)
    state.usageDeductionOutcomeUnknown = true;
  state.includedPointsDeducted = nonNegativePoints(
    cumulativeResult.includedPointsDeducted,
  );
  state.extraUsagePointsDeducted = nonNegativePoints(
    cumulativeResult.extraUsagePointsDeducted,
  );
  state.uncoveredPoints = nonNegativePoints(cumulativeResult.uncoveredPoints);
  state.usageDeductionFailed =
    cumulativeResult.usageDeductionFailed ||
    !!state.usageDeductionOutcomeUnknown;
  state.usageDeductionFailureReason = state.usageDeductionOutcomeUnknown
    ? "deduction_failed"
    : cumulativeResult.usageDeductionFailureReason;
};

/** Measure and settle a failed QA setup before releasing its reservation. */
export const prepareQaSetupUsageSettlement = ({
  userId,
  subscription,
  rateLimitInfo,
  usageRefundTracker,
  usageSettlementId,
  measureCostDollars,
}: {
  userId: string;
  subscription: SubscriptionTier;
  rateLimitInfo: RateLimitInfo;
  usageRefundTracker: UsageRefundTracker;
  usageSettlementId: string;
  measureCostDollars: () => Promise<number>;
}): (() => Promise<void>) | undefined => {
  const { qaSpendPool, resetTime } = rateLimitInfo;
  if (!qaSpendPool) return;

  usageRefundTracker.deferRefundsToSettlement();
  const settle = async () => {
    const costDollars = await measureCostDollars();
    if (!Number.isFinite(costDollars) || costDollars < 0) {
      throw new Error("QA setup cost could not be measured");
    }
    if (costDollars === 0) {
      const refund = await usageRefundTracker.refundWithResult();
      if (refund.status === "failed") {
        throw new Error("QA setup reservation could not be released");
      }
      return;
    }
    const deduction = await deductUsage(
      userId,
      subscription,
      0,
      0,
      0,
      undefined,
      costDollars,
      undefined,
      0,
      undefined,
      rateLimitInfo,
      undefined,
      usageSettlementId,
      qaSpendPool,
      resetTime.getTime(),
    );
    if (deduction.usageDeductionFailed) {
      throw new Error("QA setup usage could not be fully settled");
    }
  };
  let settlement: Promise<void> | undefined;
  return () => (settlement ??= settle());
};
