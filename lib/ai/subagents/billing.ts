import type { FreeLimitPolicy } from "@/lib/rate-limit/free-config";
import {
  addUsageDeductionDelta,
  checkFreeMonthlyCostLimit,
  checkRateLimitCapacity,
  createUsageSettlementState,
  deductUsageDelta,
  getUnsettledUsagePoints,
  getUsageSettlementInitialDeduction,
} from "@/lib/rate-limit";
import {
  createQaSpendCapError,
  createQaSpendPoolWindowChangedError,
} from "@/lib/rate-limit/qa-spending-policy";
import type {
  ExtraUsageConfig,
  RateLimitInfo,
  SubscriptionTier,
} from "@/types";

type SubagentBillingCapacityInput = {
  userId: string;
  organizationId?: string;
  subscription: SubscriptionTier;
  freeQuotaSubject?: string;
  freeLimits?: FreeLimitPolicy;
  extraUsageConfig?: ExtraUsageConfig;
  modelName: string;
};

export type SubagentBillingCapacityDependencies = {
  checkFreeMonthlyCostLimit: typeof checkFreeMonthlyCostLimit;
  checkRateLimitCapacity: typeof checkRateLimitCapacity;
};

const defaultDependencies: SubagentBillingCapacityDependencies = {
  checkFreeMonthlyCostLimit,
  checkRateLimitCapacity,
};

/**
 * Revalidate the cost capacity for a child without charging another user
 * request. A free child is part of the already-authorized parent Agent request,
 * so only its shared monthly cost budget needs another preflight check.
 */
export const checkSubagentBillingCapacity = async (
  input: SubagentBillingCapacityInput,
  dependencies: SubagentBillingCapacityDependencies = defaultDependencies,
): Promise<RateLimitInfo | undefined> => {
  if (input.subscription === "free") {
    await dependencies.checkFreeMonthlyCostLimit(
      input.freeQuotaSubject ?? input.userId,
      ...(input.freeLimits ? [input.freeLimits] : []),
    );
    return undefined;
  }

  return await dependencies.checkRateLimitCapacity(
    input.userId,
    "agent",
    input.subscription,
    input.extraUsageConfig,
    input.modelName,
    input.organizationId,
    input.freeQuotaSubject,
  );
};

export type SubagentQaUsageSettlementDependencies = {
  checkRateLimitCapacity: typeof checkRateLimitCapacity;
  deductUsageDelta: typeof deductUsageDelta;
};

export type SubagentQaUsageSettlement = {
  /** True once the child must stop: uncovered cost or a changed ledger. */
  readonly stopped: boolean;
  /** Charge cost observed since the last settlement to the admission pool. */
  settle(currentCostDollars: number): Promise<void>;
  /**
   * Before a provider request: settle observed cost, then confirm the same
   * QA pool still has capacity. Throws when the child must stop.
   */
  fence(currentCostDollars: number): Promise<void>;
  /** Cumulative mid-run debits, so final settlement charges only the rest. */
  initialDeduction(): ReturnType<typeof getUsageSettlementInitialDeduction>;
};

const defaultQaSettlementDependencies: SubagentQaUsageSettlementDependencies = {
  checkRateLimitCapacity,
  deductUsageDelta,
};

/**
 * A child admitted on the shared QA pool reserves nothing up front, so without
 * step settlement it could spend past the pool cap before its final deduction.
 * Customer and Free children keep their existing billing and get `null`.
 */
export const createSubagentQaUsageSettlement = (
  input: Omit<
    SubagentBillingCapacityInput,
    "freeQuotaSubject" | "freeLimits"
  > & {
    rateLimitInfo: RateLimitInfo | undefined;
    usageSettlementId: string;
  },
  dependencies: SubagentQaUsageSettlementDependencies = defaultQaSettlementDependencies,
): SubagentQaUsageSettlement | null => {
  const pool = input.rateLimitInfo?.qaSpendPool;
  if (!input.rateLimitInfo || !pool || input.subscription === "free") {
    return null;
  }
  const state = createUsageSettlementState(input.rateLimitInfo);
  const resetTimestamp = input.rateLimitInfo.resetTime.getTime();
  let sequence = 0;
  let stopped = false;
  // Step completion and the next request fence must never price the same
  // delta twice, so settlements run one at a time.
  let queue: Promise<void> = Promise.resolve();

  const settleNow = async (currentCostDollars: number) => {
    // An unacknowledged debit may have landed; never stack another on it.
    if (stopped || state.usageDeductionOutcomeUnknown) {
      stopped = true;
      return;
    }
    const points = getUnsettledUsagePoints(state, currentCostDollars);
    if (points <= 0) return;
    sequence += 1;
    const result = await dependencies
      .deductUsageDelta(
        input.userId,
        input.subscription,
        points,
        input.extraUsageConfig,
        input.organizationId,
        input.usageSettlementId,
        sequence,
        pool,
        resetTimestamp,
      )
      .catch(() => ({
        includedPointsDeducted: 0,
        extraUsagePointsDeducted: 0,
        uncoveredPoints: points,
        usageDeductionFailed: true,
        usageDeductionOutcomeUnknown: true,
        usageDeductionFailureReason: "deduction_failed" as const,
      }));
    // A refused ledger change also reports uncovered cost and stops the child.
    const cumulative = addUsageDeductionDelta(state, result);
    if (cumulative.uncoveredPoints > 0 || cumulative.usageDeductionFailed) {
      stopped = true;
    }
  };

  const settle = (currentCostDollars: number) => {
    const run = queue.then(() => settleNow(currentCostDollars));
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    get stopped() {
      return stopped;
    },
    settle,
    async fence(currentCostDollars) {
      await settle(currentCostDollars);
      if (!stopped) {
        let current: RateLimitInfo;
        try {
          current = await dependencies.checkRateLimitCapacity(
            input.userId,
            "agent",
            input.subscription,
            input.extraUsageConfig,
            input.modelName,
            input.organizationId,
          );
        } catch (error) {
          stopped = true;
          throw error;
        }
        if (current.qaSpendPool === pool) {
          if (current.resetTime.getTime() === resetTimestamp) return;
          stopped = true;
          throw createQaSpendPoolWindowChangedError(
            { environment: pool },
            input.subscription,
          );
        }
        stopped = true;
      }
      throw createQaSpendCapError(
        { environment: pool },
        input.subscription,
        input.rateLimitInfo?.resetTime.getTime(),
      );
    },
    initialDeduction: () => getUsageSettlementInitialDeduction(state),
  };
};
