/**
 * Fixed Window Rate Limiting (Free Users)
 *
 * Simple request counting within a daily fixed window (resets at midnight UTC).
 * Used only for free users - paid users use token bucket (cost-based).
 */

import { Ratelimit } from "@upstash/ratelimit";
import { ChatSDKError } from "@/lib/errors";
import type { RateLimitInfo } from "@/types";
import { createRedisClient } from "./redis";

/**
 * Check rate limit for free users using a fixed daily window.
 * Resets at midnight UTC each day.
 */
export const checkFreeUserRateLimit = async (
  userId: string,
): Promise<RateLimitInfo> => {
  const redis = createRedisClient();

  if (!redis) {
    throw new ChatSDKError(
      "rate_limit:chat",
      "Rate limiting service is temporarily unavailable. Please try again in a few moments.",
    );
  }

  const requestLimit = parseInt(process.env.FREE_RATE_LIMIT_REQUESTS || "10");

  try {
    const ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(requestLimit, "1 d"),
      prefix: "free_limit",
    });

    const rateLimitKey = `${userId}:free`;
    const { success, reset, remaining } = await ratelimit.limit(rateLimitKey);

    if (!success) {
      throw new ChatSDKError(
        "rate_limit:chat",
        `You've used all your daily credits. Daily credits reset at midnight UTC.\n\nUpgrade plan for higher usage limits and more features.`,
      );
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
