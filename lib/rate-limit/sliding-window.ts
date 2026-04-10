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

  const requestLimit = parseInt(process.env.FREE_RATE_LIMIT_REQUESTS || "10");

  if (!redis) {
    if (process.env.NODE_ENV !== "production") {
      // Skip rate limiting in local dev/test when Redis is not configured
      return {
        remaining: requestLimit,
        resetTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
        limit: requestLimit,
        rateLimitSkipped: true,
      };
    }
    throw new ChatSDKError(
      "rate_limit:chat",
      "Rate limiting service is not configured",
    );
  }

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
        `You've used all your daily responses. Daily responses reset at midnight UTC.\n\nUpgrade plan for higher usage limits and more features.`,
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

/**
 * Check rate limit for free users in agent mode (local sandbox only).
 * Separate daily budget from ask mode. Resets at midnight UTC.
 */
export const checkFreeAgentRateLimit = async (
  userId: string,
): Promise<RateLimitInfo> => {
  const redis = createRedisClient();

  const requestLimit = parseInt(
    process.env.FREE_AGENT_RATE_LIMIT_REQUESTS || "5",
  );

  if (!redis) {
    if (process.env.NODE_ENV !== "production") {
      // Skip rate limiting in local dev/test when Redis is not configured
      return {
        remaining: requestLimit,
        resetTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
        limit: requestLimit,
        rateLimitSkipped: true,
      };
    }
    throw new ChatSDKError(
      "rate_limit:chat",
      "Rate limiting service is not configured",
    );
  }

  try {
    const ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(requestLimit, "1 d"),
      prefix: "free_agent_limit",
    });

    const rateLimitKey = `${userId}:free_agent`;
    const { success, reset, remaining } = await ratelimit.limit(rateLimitKey);

    if (!success) {
      throw new ChatSDKError(
        "rate_limit:chat",
        `You've used all your daily agent responses. Daily responses reset at midnight UTC.\n\nUpgrade to Pro for higher limits and cloud sandbox access.`,
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
