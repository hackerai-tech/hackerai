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
 *    - Simple request counting within a daily fixed window (resets at midnight UTC)
 *    - Ask mode: 10/day (FREE_RATE_LIMIT_REQUESTS)
 *    - Agent mode (local sandbox only): 5/day (FREE_AGENT_RATE_LIMIT_REQUESTS)
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
): Promise<RateLimitInfo> => {
  // Free users: fixed daily window
  if (subscription === "free") {
    if (isAgentMode(mode)) {
      // Free agent mode (local sandbox only) has a separate daily budget
      return checkFreeAgentRateLimit(userId);
    }
    return checkFreeUserRateLimit(userId);
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
