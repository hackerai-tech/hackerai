import { Ratelimit } from "@upstash/ratelimit";
import { ChatSDKError } from "@/lib/errors";
import type {
  SubscriptionTier,
  RateLimitInfo,
  ExtraUsageConfig,
} from "@/types";
import { createRedisClient, formatTimeRemaining } from "./redis";
import { checkAgentRateLimit } from "./token-bucket";

// =============================================================================
// Sliding Window Configuration
// =============================================================================

/**
 * Get the request limit for ask mode based on subscription tier.
 */
const getAskModeRequestLimit = (subscription: SubscriptionTier): number => {
  if (subscription === "ultra") {
    return parseInt(process.env.ULTRA_RATE_LIMIT_REQUESTS || "240");
  }
  if (subscription === "team") {
    return parseInt(process.env.TEAM_RATE_LIMIT_REQUESTS || "160");
  }
  if (subscription === "pro") {
    return parseInt(process.env.PRO_RATE_LIMIT_REQUESTS || "80");
  }
  return parseInt(process.env.FREE_RATE_LIMIT_REQUESTS || "10");
};

/**
 * Get the rate limit error message based on subscription tier.
 */
const getAskModeErrorMessage = (
  subscription: SubscriptionTier,
  timeString: string,
): string => {
  if (subscription === "free") {
    return `You've reached your rate limit, please try again after ${timeString}.\n\nUpgrade plan for higher usage limits and more features.`;
  }
  if (subscription === "pro") {
    return `You've reached your ask mode rate limit, please try again after ${timeString}.\n\nYou can continue using agent mode in the meantime or upgrade to Ultra for even higher limits.`;
  }
  return `You've reached your ask mode rate limit, please try again after ${timeString}.\n\nYou can continue using agent mode in the meantime.`;
};

// =============================================================================
// Sliding Window Rate Limit Functions
// =============================================================================

/**
 * Check rate limit for ask mode.
 *
 * - Free users: Sliding window (simple request counting)
 * - Paid users: Token bucket (cost-based, same as agent mode)
 *
 * @param userId - The user's unique identifier
 * @param subscription - The user's subscription tier
 * @param estimatedInputTokens - Estimated input tokens (for token bucket)
 * @param extraUsageConfig - Optional config for extra usage charging
 * @returns Rate limit info including remaining requests/quota
 */
export const checkAskRateLimit = async (
  userId: string,
  subscription: SubscriptionTier,
  estimatedInputTokens: number = 0,
  extraUsageConfig?: ExtraUsageConfig,
): Promise<RateLimitInfo> => {
  // Paid users use token bucket (cost-based limiting, shared with agent mode)
  if (subscription !== "free") {
    return checkAgentRateLimit(
      userId,
      subscription,
      estimatedInputTokens,
      extraUsageConfig,
    );
  }

  // Free users use sliding window (simple request counting)
  const redis = createRedisClient();

  if (!redis) {
    return {
      remaining: 999,
      resetTime: new Date(Date.now() + 5 * 60 * 60 * 1000),
      limit: 999,
    };
  }

  const requestLimit = getAskModeRequestLimit(subscription);

  try {
    const ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(requestLimit, "5 h"),
      prefix: "ask_limit",
    });

    const rateLimitKey = `${userId}:ask:${subscription}`;
    const { success, reset, remaining } = await ratelimit.limit(rateLimitKey);

    if (!success) {
      const timeString = formatTimeRemaining(new Date(reset));
      const cause = getAskModeErrorMessage(subscription, timeString);
      throw new ChatSDKError("rate_limit:chat", cause);
    }

    return {
      remaining,
      resetTime: new Date(reset),
      limit: requestLimit,
    };
  } catch (error) {
    if (error instanceof ChatSDKError) throw error;
    throw new ChatSDKError(
      "rate_limit:chat",
      `Rate limiting service unavailable: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
};
