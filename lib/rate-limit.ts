import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { ChatSDKError } from "@/lib/errors";

// Check rate limit for a specific user ID
export const checkRateLimit = async (userID: string): Promise<void> => {
  // Check if Redis is configured
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    return;
  }

  try {
    // Create rate limiter instance
    const ratelimit = new Ratelimit({
      redis: new Redis({
        url: redisUrl,
        token: redisToken,
      }),
      limiter: Ratelimit.slidingWindow(
        parseInt(process.env.RATE_LIMIT_REQUESTS || "10"),
        "5 h",
      ), // Default: 10 requests per 5 hours
    });

    const { success, reset } = await ratelimit.limit(userID);

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

      const cause = `You've reached the current usage cap for HackerAI, please try again after ${timeString}.\n\nWant unlimited usage? Self-host your own HackerAI instance for free. [Learn more](https://github.com/hackerai-tech/hackerai)`;

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
