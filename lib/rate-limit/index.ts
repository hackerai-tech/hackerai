/**
 * Rate Limiting Module
 *
 * Two rate limiting strategies based on subscription tier (NOT mode):
 *
 * 1. Token Bucket (Paid users - Pro, Pro+, Ultra, Team):
 *    - Used for both Agent and Ask modes (shared budget)
 *    - Points consumed based on token usage costs
 *    - Session bucket: daily budget, refills every 5 hours
 *    - Weekly bucket: weekly budget, refills every 7 days
 *    - Supports extra usage (prepaid balance) when limits exceeded
 *
 * 2. Sliding Window (Free users - Ask mode only):
 *    - Simple request counting within a 5-hour rolling window
 *    - Agent mode is blocked for free users elsewhere in the codebase
 */

import { ChatSDKError } from "@/lib/errors";
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
  calculateTokenCost,
  getBudgetLimits,
  getSubscriptionPrice,
} from "./token-bucket";

// Re-export sliding window functions
export { checkFreeUserRateLimit } from "./sliding-window";

// Re-export utilities
export { createRedisClient, formatTimeRemaining } from "./redis";
export { UsageRefundTracker } from "./refund";

// Import for internal use
import { checkTokenBucketLimit } from "./token-bucket";
import { checkFreeUserRateLimit } from "./sliding-window";

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
): Promise<RateLimitInfo> => {
  // Free users: sliding window (agent mode is blocked elsewhere)
  if (subscription === "free") {
    // Block agent mode for free users
    if (mode === "agent") {
      throw new ChatSDKError(
        "rate_limit:chat",
        "Agent mode is not available on the free tier. Upgrade to Pro for agent mode access.",
      );
    }
    return checkFreeUserRateLimit(userId);
  }

  // Paid users: token bucket (same budget for both modes)
  return checkTokenBucketLimit(
    userId,
    subscription,
    estimatedInputTokens || 0,
    extraUsageConfig,
  );
};
