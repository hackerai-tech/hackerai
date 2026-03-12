import { Redis } from "@upstash/redis";

// Singleton Redis client instance
let redisClient: Redis | null = null;
let redisInitialized = false;

/**
 * Get or create a singleton Redis client for rate limiting.
 * Returns null if Redis is not configured.
 */
export const createRedisClient = (): Redis | null => {
  // Return cached client if already initialized
  if (redisInitialized) {
    return redisClient;
  }

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  redisInitialized = true;

  if (!redisUrl || !redisToken) {
    redisClient = null;
    return null;
  }

  redisClient = new Redis({
    url: redisUrl,
    token: redisToken,
  });

  return redisClient;
};

/**
 * Format time difference into a human-readable string.
 */
export const formatTimeRemaining = (resetTime: Date): string => {
  const now = new Date();
  const timeDiff = resetTime.getTime() - now.getTime();

  if (timeDiff <= 0) {
    return "less than a minute";
  }

  const hours = Math.floor(timeDiff / (1000 * 60 * 60));

  // For short durations (< 24h), show relative time with "in" prefix
  if (hours < 24) {
    const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));
    if (hours <= 0) {
      if (minutes <= 0) {
        return "in less than a minute";
      }
      return `in ${minutes} minute${minutes > 1 ? "s" : ""}`;
    }
    return `in ${hours} hour${hours > 1 ? "s" : ""}${minutes > 0 ? ` and ${minutes} minute${minutes > 1 ? "s" : ""}` : ""}`;
  }

  // For longer durations, show the reset date and time with "on" prefix
  return `on ${resetTime.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  })}`;
};
