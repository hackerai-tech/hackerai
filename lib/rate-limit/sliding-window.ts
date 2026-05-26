/**
 * Fixed Window Rate Limiting (Free Users)
 *
 * Simple request-unit counting within a daily fixed window (resets at midnight UTC).
 * Used only for free users - paid users use token bucket (cost-based).
 */

import { ChatSDKError } from "@/lib/errors";
import type { RateLimitInfo } from "@/types";
import {
  FREE_AGENT_REQUEST_COST,
  FREE_ASK_REQUEST_COST,
  getFreeRequestLimit,
} from "./free-config";
import { createRedisClient } from "./redis";
import { spendReferralCreditsForFreeUsage } from "@/lib/referrals";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Upstash fixedWindow supports `{ rate: 2 }`, but failed multi-unit calls are
// counted before failure is returned. This checks capacity before incrementing
// so a blocked agent request cannot consume the last ask unit.
const CONSUME_FREE_REQUEST_UNITS_SCRIPT = `
local key = KEYS[1]
local requestLimit = tonumber(ARGV[1])
local requestCost = tonumber(ARGV[2])
local ttlMs = tonumber(ARGV[3])
local used = tonumber(redis.call("GET", key) or "0")
local remaining = requestLimit - used

if requestCost > requestLimit or remaining < requestCost then
  return {0, remaining}
end

local nextUsed = redis.call("INCRBY", key, requestCost)
if nextUsed == requestCost then
  redis.call("PEXPIRE", key, ttlMs)
end

return {1, requestLimit - nextUsed}
`;

const getCurrentUtcDayWindow = () => {
  const now = Date.now();
  const bucket = Math.floor(now / ONE_DAY_MS);
  const reset = (bucket + 1) * ONE_DAY_MS;
  return {
    bucket,
    reset,
    ttlMs: Math.max(1, reset - now),
  };
};

const consumeFreeRequestUnits = async ({
  redis,
  userId,
  requestLimit,
  requestCost,
  bucket,
  ttlMs,
}: {
  redis: NonNullable<ReturnType<typeof createRedisClient>>;
  userId: string;
  requestLimit: number;
  requestCost: number;
  bucket: number;
  ttlMs: number;
}) => {
  const rateLimitKey = `free_limit:${userId}:free:${bucket}`;
  const result = (await redis.eval(
    CONSUME_FREE_REQUEST_UNITS_SCRIPT,
    [rateLimitKey],
    [requestLimit, requestCost, ttlMs],
  )) as [number | string, number | string];

  return {
    success: Number(result[0]) === 1,
    remaining: Math.max(0, Number(result[1])),
  };
};

/**
 * Check rate limit for free users using a fixed daily request-unit window.
 * Resets at midnight UTC each day.
 */
export const checkFreeUserRateLimit = async (
  userId: string,
  requestCost = FREE_ASK_REQUEST_COST,
): Promise<RateLimitInfo> => {
  const redis = createRedisClient();

  const requestLimit = getFreeRequestLimit();
  const cost = Math.max(1, Math.trunc(requestCost));
  const { bucket, reset, ttlMs } = getCurrentUtcDayWindow();

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
    const { success, remaining } = await consumeFreeRequestUnits({
      redis,
      userId,
      requestLimit,
      requestCost: cost,
      bucket,
      ttlMs,
    });

    if (!success) {
      const spentReferralCredits = await spendReferralCreditsForFreeUsage({
        userId,
        amountCredits: cost,
        idempotencyKey: `free_overflow:${userId}:${bucket}:${Date.now()}`,
      });

      if (spentReferralCredits) {
        return {
          remaining: 0,
          resetTime: new Date(reset),
          limit: requestLimit,
          referralCreditsDeducted: cost,
        };
      }

      throw new ChatSDKError(
        "rate_limit:chat",
        `You've used all your daily requests. Daily requests reset at midnight UTC.\n\nUpgrade plan for higher usage limits and more features.`,
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
 * Shares the free daily request-unit budget with ask mode. Agent requests cost
 * 2 units, so the default 10-unit budget still allows up to 5 agent requests.
 */
export const checkFreeAgentRateLimit = async (
  userId: string,
): Promise<RateLimitInfo> => {
  return checkFreeUserRateLimit(userId, FREE_AGENT_REQUEST_COST);
};
