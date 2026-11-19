import { Redis } from "@upstash/redis";

type RedisClientPurpose = "default" | "qa-debit";

const redisClients: Partial<Record<RedisClientPurpose, Redis | null>> = {};

/**
 * Reuse a Redis client for rate limiting. QA debits use a single HTTP attempt
 * because a lost response can hide a mutation that already committed.
 * Returns null if Redis is not configured.
 */
export const createRedisClient = (
  purpose: RedisClientPurpose = "default",
): Redis | null => {
  const cached = redisClients[purpose];
  if (cached !== undefined) return cached;

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  const client =
    redisUrl && redisToken
      ? new Redis({
          url: redisUrl,
          token: redisToken,
          ...(purpose === "qa-debit" && { retry: { retries: 0 } }),
        })
      : null;
  redisClients[purpose] = client;
  return client;
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
