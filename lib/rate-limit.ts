import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { ChatSDKError } from "@/lib/errors";

// Check rate limit for a specific user
export const checkRateLimit = async (
  userId: string,
  isPro: boolean,
): Promise<void> => {
  // Check if Redis is configured
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    return;
  }

  try {
    // Get rate limit based on user type
    const requestLimit = isPro
      ? parseInt(process.env.PRO_RATE_LIMIT_REQUESTS || "100") // Pro users get higher limit
      : parseInt(process.env.FREE_RATE_LIMIT_REQUESTS || "10"); // Free users get lower limit

    // Create rate limiter instance
    const ratelimit = new Ratelimit({
      redis: new Redis({
        url: redisUrl,
        token: redisToken,
      }),
      limiter: Ratelimit.slidingWindow(requestLimit, "5 h"),
    });

    const { success, reset } = await ratelimit.limit(userId);

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
      if (isPro) {
        cause = `You've reached your rate limit, please try again after ${timeString}.`;
      } else {
        cause = `You've reached your rate limit, please try again after ${timeString}.\n\nUpgrade to Pro for higher usage limits and more features.`;
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
