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

// Re-export token bucket functions
export {
  checkTokenBucketLimit,
  deductUsage,
  refundUsage,
  resetRateLimitBuckets,
  stashOldBucketRemaining,
  popOldBucketRemaining,
  initProratedBucket,
  calculateProratedCredits,
  getTeamMemberConsumed,
  addOrgRemovedUsage,
  clearOrgRemovedUsage,
  applyTeamSeatDebt,
  calculateTokenCost,
  getBudgetLimits,
  getSubscriptionPrice,
  POINTS_PER_DOLLAR,
} from "./token-bucket";

// Re-export sliding window functions
export {
  checkFreeUserRateLimit,
  checkFreeAgentRateLimit,
} from "./sliding-window";

// Re-export utilities
export { createRedisClient, formatTimeRemaining } from "./redis";
export { UsageRefundTracker } from "./refund";
export { acquireFreeRunConcurrencyLock } from "./free-concurrency";
export {
  checkFreeMonthlyCostLimit,
  recordFreeMonthlyCost,
} from "./free-monthly-cost";

// Import for internal use
import { checkTokenBucketLimit } from "./token-bucket";
import {
  checkFreeUserRateLimit,
  checkFreeAgentRateLimit,
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
  requestId?: string,
): Promise<RateLimitInfo> => {
  // Free users: fixed daily window
  if (subscription === "free") {
    if (!requestId) {
      throw new Error("requestId is required for free rate limiting");
    }
    if (isAgentMode(mode)) {
      // Free agent mode shares the daily free budget and consumes 2 units.
      return checkFreeAgentRateLimit(userId, requestId);
    }
    return checkFreeUserRateLimit(userId, requestId);
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
