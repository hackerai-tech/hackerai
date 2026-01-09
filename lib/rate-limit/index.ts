/**
 * Rate Limiting Module
 *
 * This module provides two rate limiting strategies:
 *
 * 1. Token Bucket (Agent Mode):
 *    - Allows burst requests while maintaining sustainable rate
 *    - Points are consumed based on model usage costs
 *    - Bucket refills over time (per hour)
 *
 * 2. Sliding Window (Ask Mode):
 *    - Simple request counting within a rolling window
 *    - Fixed number of requests per 5-hour period
 */

import type { ChatMode, SubscriptionTier, RateLimitInfo } from "@/types";

// Re-export token bucket functions
export {
  checkAgentRateLimit,
  deductAgentUsage,
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

// Import for use in checkRateLimit
import { checkAgentRateLimit } from "./token-bucket";
import { checkAskRateLimit } from "./sliding-window";

/**
 * Check rate limit for a specific user.
 *
 * Routes to the appropriate rate limiting strategy based on mode:
 * - Agent mode: Token bucket (checks if estimated cost fits in budget)
 * - Ask mode: Sliding window (simple request counting)
 *
 * @param userId - The user's unique identifier
 * @param mode - The chat mode ("agent" or "ask")
 * @param subscription - The user's subscription tier
 * @param estimatedInputTokens - Estimated input tokens (agent mode only)
 * @param modelName - Model name for pricing (agent mode only)
 * @returns Rate limit info including remaining quota
 */
export const checkRateLimit = async (
  userId: string,
  mode: ChatMode,
  subscription: SubscriptionTier,
  estimatedInputTokens?: number,
  modelName = "",
): Promise<RateLimitInfo> => {
  if (mode === "agent") {
    return checkAgentRateLimit(
      userId,
      subscription,
      estimatedInputTokens || 0,
      modelName,
    );
  }

  return checkAskRateLimit(userId, subscription);
};
