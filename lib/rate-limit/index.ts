/**
 * Rate Limiting Module
 *
 * This module provides two rate limiting strategies:
 *
 * 1. Token Bucket (Agent Mode + Ask Mode for paid users):
 *    - Allows burst requests while maintaining sustainable rate
 *    - Points are consumed based on model usage costs
 *    - Bucket refills over time (per hour for session, per week for weekly)
 *    - Agent and Ask modes share the same budget pool (100% of subscription)
 *
 * 2. Sliding Window (Ask Mode for free users only):
 *    - Simple request counting within a rolling window
 *    - Fixed number of requests per 5-hour period
 */

import type {
  ChatMode,
  SubscriptionTier,
  RateLimitInfo,
  ExtraUsageConfig,
} from "@/types";

// Re-export token bucket functions (used by both agent and ask modes for paid users)
export {
  checkAgentRateLimit,
  deductAgentUsage,
  refundUsage,
  calculateTokenCost,
  getBudgetLimits,
  calculateBucketLimit,
  calculateWeeklyLimit,
  getSubscriptionPrice,
} from "./token-bucket";

// Re-export sliding window functions
export { checkAskRateLimit } from "./sliding-window";

// Re-export utilities
export { createRedisClient, formatTimeRemaining } from "./redis";
export { UsageRefundTracker } from "./refund";

// Import for use in checkRateLimit
import { checkAgentRateLimit } from "./token-bucket";
import { checkAskRateLimit } from "./sliding-window";

/**
 * Check rate limit for a specific user.
 *
 * Routes to the appropriate rate limiting strategy based on mode:
 * - Agent mode: Token bucket (checks if estimated cost fits in budget)
 * - Ask mode (paid users): Token bucket (checks if estimated cost fits in budget)
 * - Ask mode (free users): Sliding window (simple request counting)
 *
 * @param userId - The user's unique identifier
 * @param mode - The chat mode ("agent" or "ask")
 * @param subscription - The user's subscription tier
 * @param estimatedInputTokens - Estimated input tokens (for token bucket modes)
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
  if (mode === "agent") {
    return checkAgentRateLimit(
      userId,
      subscription,
      estimatedInputTokens || 0,
      extraUsageConfig,
    );
  }

  // Ask mode: token bucket for paid users (with extra usage), sliding window for free users
  return checkAskRateLimit(
    userId,
    subscription,
    estimatedInputTokens || 0,
    extraUsageConfig,
  );
};
