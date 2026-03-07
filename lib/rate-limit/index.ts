/**
 * Rate Limiting Module
 *
 * Two rate limiting strategies based on subscription tier (NOT mode):
 *
 * 1. Token Bucket (Paid users - Pro, Pro+, Ultra, Team):
 *    - Used for both Agent and Ask modes (shared budget)
 *    - Single monthly budget based on subscription price
 *    - Costs consumed based on model token pricing (in dollars)
 *    - Supports extra usage (prepaid balance) when monthly limit exceeded
 *
 * 2. Sliding Window (Free users - Ask mode only):
 *    - Simple request counting within a 5-hour rolling window
 *    - Agent mode is blocked for free users in checkRateLimit()
 */

import { ChatSDKError } from "@/lib/errors";
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
  calculateTokenCost,
  getBudgetLimit,
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
 * - Paid users: Token bucket (cost-based, shared monthly budget)
 */
export const checkRateLimit = async (
  userId: string,
  mode: ChatMode,
  subscription: SubscriptionTier,
  estimatedInputTokens?: number,
  extraUsageConfig?: ExtraUsageConfig,
  modelName?: string,
): Promise<RateLimitInfo> => {
  // Free users: sliding window
  if (subscription === "free") {
    // Block agent mode for free users
    if (isAgentMode(mode)) {
      throw new ChatSDKError(
        "rate_limit:chat",
        "Agent mode is not available on the free tier. Upgrade to Pro for agent mode access.",
      );
    }
    return checkFreeUserRateLimit(userId);
  }

  // Paid users: token bucket (same monthly budget for both modes)
  return checkTokenBucketLimit(
    userId,
    subscription,
    estimatedInputTokens || 0,
    extraUsageConfig,
    modelName,
  );
};
