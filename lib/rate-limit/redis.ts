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
  const hours = Math.floor(timeDiff / (1000 * 60 * 60));
  const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours <= 0 && minutes <= 0) {
    return "less than a minute";
  }

  let timeString = "";
  if (hours > 0) {
    timeString = `${hours} hour${hours > 1 ? "s" : ""}`;
    if (minutes > 0) {
      timeString += ` and ${minutes} minute${minutes > 1 ? "s" : ""}`;
    }
  } else {
    timeString = `${minutes} minute${minutes > 1 ? "s" : ""}`;
  }

  return timeString;
};
