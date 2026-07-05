import type { ExtraUsageConfig, RateLimitInfo } from "@/types";
import {
  billableCostDollarsToPoints,
  POINTS_PER_DOLLAR,
  type UsageDeductionFailureReason,
  type UsageDeductionResult,
} from "./token-bucket";

export const MID_RUN_SETTLEMENT_MIN_DELTA_DOLLARS = 0.5;
export const MID_RUN_SETTLEMENT_MIN_DELTA_POINTS = billableCostDollarsToPoints(
  MID_RUN_SETTLEMENT_MIN_DELTA_DOLLARS,
);

export type UsageSettlementState = {
  initialIncludedPointsDeducted: number;
  initialExtraUsagePointsDeducted: number;
  includedPointsDeducted: number;
  extraUsagePointsDeducted: number;
  uncoveredPoints: number;
  usageDeductionFailed: boolean;
  usageDeductionFailureReason?: UsageDeductionFailureReason;
  monthlyRemainingAtStartPoints: number;
  extraUsageBalanceAtStartPoints: number;
  extraUsageMonthlyRemainingAtStartPoints?: number;
};

const nonNegativePoints = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;

export const costDollarsToPoints = (costDollars: number): number =>
  Number.isFinite(costDollars)
    ? Math.max(
        0,
        Math.ceil(Number((costDollars * POINTS_PER_DOLLAR).toFixed(6))),
      )
    : 0;

export const createUsageSettlementState = (
  rateLimitInfo: RateLimitInfo,
  extraUsageConfig?: ExtraUsageConfig,
): UsageSettlementState => {
  const initialIncludedPointsDeducted = nonNegativePoints(
    rateLimitInfo.pointsDeducted,
  );
  const initialExtraUsagePointsDeducted = nonNegativePoints(
    rateLimitInfo.extraUsagePointsDeducted,
  );

  return {
    initialIncludedPointsDeducted,
    initialExtraUsagePointsDeducted,
    includedPointsDeducted: initialIncludedPointsDeducted,
    extraUsagePointsDeducted: initialExtraUsagePointsDeducted,
    uncoveredPoints: 0,
    usageDeductionFailed: false,
    monthlyRemainingAtStartPoints: nonNegativePoints(
      rateLimitInfo.monthly?.remaining ?? rateLimitInfo.remaining,
    ),
    extraUsageBalanceAtStartPoints: Math.max(
      0,
      costDollarsToPoints(extraUsageConfig?.balanceDollars ?? 0) -
        initialExtraUsagePointsDeducted,
    ),
    extraUsageMonthlyRemainingAtStartPoints:
      extraUsageConfig?.monthlyRemainingDollars === undefined
        ? undefined
        : Math.max(
            0,
            costDollarsToPoints(extraUsageConfig.monthlyRemainingDollars) -
              initialExtraUsagePointsDeducted,
          ),
  };
};

export const getUsageSettlementInitialDeduction = (
  state: UsageSettlementState,
): Pick<RateLimitInfo, "pointsDeducted" | "extraUsagePointsDeducted"> => ({
  pointsDeducted: state.includedPointsDeducted,
  extraUsagePointsDeducted: state.extraUsagePointsDeducted,
});

export const getSettledUsagePoints = (state: UsageSettlementState): number =>
  state.includedPointsDeducted + state.extraUsagePointsDeducted;

const getKnownUnsettledCushionPoints = (
  state: UsageSettlementState,
): number => {
  const includedDeductedAfterStart = Math.max(
    0,
    state.includedPointsDeducted - state.initialIncludedPointsDeducted,
  );
  const includedCushion = Math.max(
    0,
    state.monthlyRemainingAtStartPoints - includedDeductedAfterStart,
  );

  const extraDeductedAfterStart = Math.max(
    0,
    state.extraUsagePointsDeducted - state.initialExtraUsagePointsDeducted,
  );
  const balanceCushion = Math.max(
    0,
    state.extraUsageBalanceAtStartPoints - extraDeductedAfterStart,
  );
  const extraMonthlyCapCushion =
    state.extraUsageMonthlyRemainingAtStartPoints === undefined
      ? balanceCushion
      : Math.max(
          0,
          state.extraUsageMonthlyRemainingAtStartPoints -
            extraDeductedAfterStart,
        );
  const extraCushion = Math.min(balanceCushion, extraMonthlyCapCushion);

  return includedCushion + extraCushion;
};

export const getUnsettledUsagePoints = (
  state: UsageSettlementState,
  currentCostDollars: number,
): number =>
  Math.max(
    0,
    billableCostDollarsToPoints(currentCostDollars) -
      getSettledUsagePoints(state),
  );

export const shouldSettleUsageMidRun = ({
  state,
  currentCostDollars,
  force = false,
}: {
  state: UsageSettlementState;
  currentCostDollars: number;
  force?: boolean;
}): boolean => {
  const unsettledPoints = getUnsettledUsagePoints(state, currentCostDollars);
  if (unsettledPoints <= 0) return false;
  if (force) return true;
  if (unsettledPoints < MID_RUN_SETTLEMENT_MIN_DELTA_POINTS) return false;
  return unsettledPoints > getKnownUnsettledCushionPoints(state);
};

export const addUsageDeductionDelta = (
  state: UsageSettlementState,
  result: UsageDeductionResult,
): UsageDeductionResult => {
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
    ...(state.usageDeductionFailureReason && {
      usageDeductionFailureReason: state.usageDeductionFailureReason,
    }),
  };
};

export const replaceUsageSettlementState = (
  state: UsageSettlementState,
  cumulativeResult: UsageDeductionResult,
): void => {
  state.includedPointsDeducted = nonNegativePoints(
    cumulativeResult.includedPointsDeducted,
  );
  state.extraUsagePointsDeducted = nonNegativePoints(
    cumulativeResult.extraUsagePointsDeducted,
  );
  state.uncoveredPoints = nonNegativePoints(cumulativeResult.uncoveredPoints);
  state.usageDeductionFailed = cumulativeResult.usageDeductionFailed;
  state.usageDeductionFailureReason =
    cumulativeResult.usageDeductionFailureReason;
};
