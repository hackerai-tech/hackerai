import { Redis } from "@upstash/redis";

/**
 * Create a Redis client for rate limiting.
 * Returns null if Redis is not configured.
 */
export const createRedisClient = (): Redis | null => {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    return null;
  }

  return new Redis({
    url: redisUrl,
    token: redisToken,
  });
};

/**
 * Format time difference into a human-readable string.
 */
export const formatTimeRemaining = (resetTime: Date): string => {
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

  return timeString;
};
