import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { ChatSDKError } from "@/lib/errors";
import type { ChatMode, SubscriptionTier } from "@/types";

// Check rate limit for a specific user
export const checkRateLimit = async (
  userId: string,
  mode: ChatMode,
  subscription: SubscriptionTier,
): Promise<void> => {
  // Check if Redis is configured
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    return;
  }

  try {
    // Get rate limit based on subscription tier and mode
    let requestLimit: number;

    if (mode === "agent") {
      // Agent mode is only for paid users; ultra gets higher cap
      if (subscription === "ultra") {
        requestLimit = parseInt(
          process.env.ULTRA_AGENT_MODE_RATE_LIMIT_REQUESTS || "90",
        );
      } else if (subscription === "team") {
        requestLimit = parseInt(
          process.env.TEAM_AGENT_MODE_RATE_LIMIT_REQUESTS || "65",
        );
      } else {
        requestLimit = parseInt(
          process.env.AGENT_MODE_RATE_LIMIT_REQUESTS || "45",
        );
      }
    } else {
      // Regular ask mode limits with ultra and team tiers
      if (subscription === "ultra") {
        requestLimit = parseInt(process.env.ULTRA_RATE_LIMIT_REQUESTS || "240");
      } else if (subscription === "team") {
        requestLimit = parseInt(process.env.TEAM_RATE_LIMIT_REQUESTS || "160");
      } else if (subscription === "pro") {
        requestLimit = parseInt(process.env.PRO_RATE_LIMIT_REQUESTS || "80");
      } else {
        requestLimit = parseInt(process.env.FREE_RATE_LIMIT_REQUESTS || "10");
      }
    }

    // Create rate limiter instance with mode-specific key
    const ratelimit = new Ratelimit({
      redis: new Redis({
        url: redisUrl,
        token: redisToken,
      }),
      limiter: Ratelimit.slidingWindow(requestLimit, "5 h"),
    });

    // Use mode-specific key for rate limiting
    const rateLimitKey = `${userId}:${mode}:${subscription}`;
    const { success, reset } = await ratelimit.limit(rateLimitKey);

    if (!success) {
      const resetTime = new Date(reset);
      const now = new Date();
      const timeDiff = resetTime.getTime() - now.getTime();
      const hours = Math.floor(timeDiff / (1000 * 60 * 60));
      const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));

      let timeString = "";
      if (hours > 0) {
        timeString = `${hours} hour${hours > 1 ? "s" : ""}`;
        if (minutes > 0) {
          timeString += ` and ${minutes} minute${minutes > 1 ? "s" : ""}`;
        }
      } else {
        timeString = `${minutes} minute${minutes > 1 ? "s" : ""}`;
      }

      let cause: string;

      if (subscription !== "free") {
        if (mode === "agent") {
          cause = `You've reached your agent mode rate limit, please try again after ${timeString}.\n\nYou can continue using ask mode in the meantime.`;
        } else {
          cause = `You've reached your ask mode rate limit, please try again after ${timeString}.\n\nYou can continue using agent mode in the meantime.`;
        }
      } else {
        cause = `You've reached your rate limit, please try again after ${timeString}.\n\nUpgrade plan for higher usage limits and more features.`;
      }

      throw new ChatSDKError("rate_limit:chat", cause);
    }
  } catch (error) {
    // If it's already our ChatSDKError, re-throw it
    if (error instanceof ChatSDKError) {
      throw error;
    }

    // For any other error (Redis connection issues, etc.), throw a generic rate limit error
    throw new ChatSDKError(
      "rate_limit:chat",
      `Rate limiting service unavailable: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
};
