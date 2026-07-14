/**
 * Rate Limiting Module
 *
 * Two rate limiting strategies based on subscription tier (NOT mode):
 *
 * 1. Token Bucket (Paid users - Pro, Pro+, Ultra, Team):
 *    - Used for both Agent and Ask modes (shared budget)
 *    - Points consumed based on token usage costs
 *    - Single monthly bucket: credits = subscription price, refills every 30 days
 *    - Supports extra usage (prepaid balance) when limits exceeded
 *
 * 2. Fixed Window (Free users):
 *    - Shared request-unit counting within a daily fixed window (resets at midnight UTC)
 *    - Ask mode costs 1 unit
 *    - Agent mode (local sandbox only) costs 2 units
 *    - Default free budget: 10 units/day (FREE_RATE_LIMIT_REQUESTS)
 */

import { isAgentMode } from "@/lib/utils/mode-helpers";
import type {
  ChatMode,
  SubscriptionTier,
  RateLimitInfo,
  ExtraUsageConfig,
} from "@/types";
import { canUseExtraUsage } from "@/types";
import { ChatSDKError } from "@/lib/errors";

// Re-export token bucket functions
export {
  checkTokenBucketLimit,
  deductUsage,
  deductUsageDelta,
  refundUsage,
  resetRateLimitBuckets,
  capCurrentCycleAllocation,
  stashOldBucketRemaining,
  popOldBucketRemaining,
  initProratedBucket,
  calculateProratedCredits,
  getTeamMemberConsumed,
  addOrgRemovedUsage,
  clearOrgRemovedUsage,
  applyTeamSeatDebt,
  billableCostDollarsToPoints,
  calculateTokenCost,
  calculateRawTokenCost,
  getBudgetLimits,
  getSubscriptionPrice,
  getMonthlyBucketKey,
  getCycleExpireSeconds,
  POINTS_PER_DOLLAR,
  type UsageDeductionFailureReason,
  type UsageDeductionResult,
  type CycleAllocationCapResult,
} from "./token-bucket";

// Re-export sliding window functions
export {
  checkFreeUserRateLimit,
  checkFreeAgentRateLimit,
  checkFreeUserRateLimitCapacity,
  checkFreeAgentRateLimitCapacity,
  grantFreeReferralBonusUnits,
} from "./sliding-window";

// Re-export utilities
export { createRedisClient, formatTimeRemaining } from "./redis";
export { UsageRefundTracker } from "./refund";
export {
  addUsageDeductionDelta,
  createUsageSettlementState,
  getUsageSettlementInitialDeduction,
  getUnsettledUsagePoints,
  shouldSettleUsageMidRun,
  replaceUsageSettlementState,
  type UsageSettlementState,
} from "./usage-settlement";
export { acquireFreeRunConcurrencyLock } from "./free-concurrency";
export {
  checkFreeMonthlyCostLimit,
  recordFreeMonthlyCost,
} from "./free-monthly-cost";
export {
  getPaidDailyFreeAllowanceStatus,
  reservePaidDailyFreeAllowanceRequest,
  recordPaidDailyFreeAllowanceCost,
  paidDailyFreeAllowanceStatusToMetadata,
  getPaidDailyFreeAllowanceKeys,
  getPaidDailyFreeAllowanceRolloutPercent,
  getPaidDailyFreeAllowanceRequestsPerDay,
  getPaidDailyFreeAllowanceCostLimitDollars,
  PAID_DAILY_FREE_ALLOWANCE_COST_LIMIT_USD_DEFAULT,
  PAID_DAILY_FREE_ALLOWANCE_REQUESTS_PER_DAY_DEFAULT,
  PAID_DAILY_FREE_ALLOWANCE_ROLLOUT_PERCENT_DEFAULT,
  type PaidDailyFreeAllowanceMetadata,
  type PaidDailyFreeAllowanceReservation,
  type PaidDailyFreeAllowanceStatus,
  type PaidDailyFreeAllowanceCostRecordResult,
} from "./paid-daily-free-allowance";

// Import for internal use
import { checkTokenBucketLimit } from "./token-bucket";
import {
  checkFreeUserRateLimit,
  checkFreeAgentRateLimit,
  checkFreeUserRateLimitCapacity,
  checkFreeAgentRateLimitCapacity,
} from "./sliding-window";

/**
 * Check rate limit for a user.
 *
 * Routes to the appropriate strategy based on subscription tier:
 * - Free users: Sliding window (simple request counting)
 * - Paid users: Token bucket (cost-based, shared budget for all modes)
 *
 * @param userId - The user's unique identifier
 * @param mode - The chat mode ("agent" or "ask") - used only for agent mode blocking
 * @param subscription - The user's subscription tier
 * @param estimatedInputTokens - Estimated input tokens (for token bucket)
 * @param extraUsageConfig - Optional config for extra usage charging
 * @param freeQuotaSubject - Privacy-safe identity-scoped key for free-tier limits
 * @returns Rate limit info including remaining quota
 */
export const checkRateLimit = async (
  userId: string,
  mode: ChatMode,
  subscription: SubscriptionTier,
  estimatedInputTokens?: number,
  extraUsageConfig?: ExtraUsageConfig,
  modelName?: string,
  organizationId?: string,
  freeQuotaSubject?: string,
): Promise<RateLimitInfo> => {
  // Free users: fixed daily window
  if (subscription === "free") {
    const quotaSubject = freeQuotaSubject ?? userId;
    if (isAgentMode(mode)) {
      // Free agent mode shares the daily free budget and consumes 2 units.
      return checkFreeAgentRateLimit(quotaSubject);
    }
    return checkFreeUserRateLimit(quotaSubject);
  }

  // Paid users: token bucket (same budget for both modes)
  return checkTokenBucketLimit(
    userId,
    subscription,
    estimatedInputTokens || 0,
    extraUsageConfig,
    modelName,
    organizationId,
  );
};

/**
 * Revalidate capacity after a durable wait without consuming request units or
 * deducting estimated model cost a second time.
 */
export const checkRateLimitCapacity = async (
  userId: string,
  mode: ChatMode,
  subscription: SubscriptionTier,
  extraUsageConfig?: ExtraUsageConfig,
  modelName?: string,
  organizationId?: string,
  freeQuotaSubject?: string,
): Promise<RateLimitInfo> => {
  if (subscription === "free") {
    const quotaSubject = freeQuotaSubject ?? userId;
    return isAgentMode(mode)
      ? checkFreeAgentRateLimitCapacity(quotaSubject)
      : checkFreeUserRateLimitCapacity(quotaSubject);
  }

  const current = await checkTokenBucketLimit(
    userId,
    subscription,
    0,
    extraUsageConfig,
    modelName,
    organizationId,
  );
  if (current.remaining > 0 || canUseExtraUsage(extraUsageConfig)) {
    return current;
  }

  throw new ChatSDKError(
    "rate_limit:chat",
    "Your current usage limit no longer allows this approved operation. Start a new Agent request after your limit resets or add extra usage credits.",
  );
};
