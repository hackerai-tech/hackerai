/**
 * Sliding Window Rate Limiting (Free Users)
 *
 * Simple request counting within a 5-hour rolling window.
 * Used only for free users - paid users use token bucket (cost-based).
 */

import { Ratelimit } from "@upstash/ratelimit";
import { ChatSDKError } from "@/lib/errors";
import type { RateLimitInfo } from "@/types";
import { createRedisClient, formatTimeRemaining } from "./redis";

/**
 * Check rate limit for free users using sliding window (without consuming).
 * Uses getRemaining so the request is only consumed on success via consumeFreeUserRateLimit.
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
      limiter: Ratelimit.slidingWindow(requestLimit, "5 h"),
      prefix: "free_limit",
    });

    const rateLimitKey = `${userId}:free`;
    const { remaining, reset } = await ratelimit.getRemaining(rateLimitKey);

    if (remaining <= 0) {
      const timeString = formatTimeRemaining(new Date(reset));
      throw new ChatSDKError(
        "rate_limit:chat",
        `You've reached your rate limit, please try again ${timeString}.\n\nUpgrade plan for higher usage limits and more features.`,
      );
    }

    // Return remaining - 1 so UI shows count after this request would be consumed on success
    return {
      remaining: remaining - 1,
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
 * Consume one request from the free user sliding window. Call only after a successful AI response.
 * Fire-and-forget: errors are logged but not thrown.
 */
export const consumeFreeUserRateLimit = async (
  userId: string,
): Promise<void> => {
  const redis = createRedisClient();
  if (!redis) {
    return;
  }

  const requestLimit = parseInt(process.env.FREE_RATE_LIMIT_REQUESTS || "10");
  const ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(requestLimit, "5 h"),
    prefix: "free_limit",
  });

  const rateLimitKey = `${userId}:free`;
  try {
    await ratelimit.limit(rateLimitKey);
  } catch (error) {
    // Log but don't throw - response was already served
    console.warn(
      "Free user rate limit consume failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
};
