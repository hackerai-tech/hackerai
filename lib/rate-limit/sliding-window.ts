/**
 * Fixed Window Rate Limiting (Free Users)
 *
 * Simple request-unit counting within a daily fixed window (resets at midnight UTC).
 * Used only for free users - paid users use token bucket (cost-based).
 */

import { ChatSDKError } from "@/lib/errors";
import type { RateLimitInfo } from "@/types";
import { getLimitPressureContext } from "@/lib/limit-pressure";
import {
  FREE_AGENT_REQUEST_COST,
  FREE_ASK_REQUEST_COST,
  getFreeRequestLimit,
} from "./free-config";
import { createRedisClient } from "./redis";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const REFERRAL_BONUS_TTL_SECONDS = 30 * 24 * 60 * 60;

const getFreeReferralBonusKey = (userId: string) =>
  `free_referral_bonus:${userId}`;

const getFreeReferralBonusGrantKey = (idempotencyKey: string) =>
  `free_referral_bonus_grant:${idempotencyKey}`;

// Upstash fixedWindow supports `{ rate: 2 }`, but failed multi-unit calls are
// counted before failure is returned. This checks capacity before incrementing
// so a blocked agent request cannot consume the last ask unit.
const CONSUME_FREE_REQUEST_UNITS_SCRIPT = `
local usageKey = KEYS[1]
local bonusKey = KEYS[2]
local requestLimit = tonumber(ARGV[1])
local requestCost = tonumber(ARGV[2])
local ttlMs = tonumber(ARGV[3])
local used = tonumber(redis.call("GET", usageKey) or "0")
local bonusRemaining = tonumber(redis.call("GET", bonusKey) or "0")
local baseRemaining = requestLimit - used

if baseRemaining < 0 then
  baseRemaining = 0
end

if bonusRemaining < 0 then
  bonusRemaining = 0
end

local totalRemaining = baseRemaining + bonusRemaining

if totalRemaining < requestCost then
  return {0, totalRemaining}
end

local bonusToConsume = 0
if requestCost > baseRemaining then
  bonusToConsume = requestCost - baseRemaining
end

local nextUsed = redis.call("INCRBY", usageKey, requestCost)
if nextUsed == requestCost then
  redis.call("PEXPIRE", usageKey, ttlMs)
end

local nextBonusRemaining = bonusRemaining
if bonusToConsume > 0 then
  nextBonusRemaining = redis.call("DECRBY", bonusKey, bonusToConsume)
  if nextBonusRemaining <= 0 then
    redis.call("DEL", bonusKey)
    nextBonusRemaining = 0
  end
end

local nextBaseRemaining = requestLimit - nextUsed
if nextBaseRemaining < 0 then
  nextBaseRemaining = 0
end

return {1, nextBaseRemaining + nextBonusRemaining}
`;

const GRANT_FREE_REFERRAL_BONUS_UNITS_SCRIPT = `
local bonusKey = KEYS[1]
local grantKey = KEYS[2]
local bonusUnits = tonumber(ARGV[1])
local ttlSeconds = tonumber(ARGV[2])

local didSet = redis.call("SET", grantKey, "1", "NX", "EX", ttlSeconds)
if not didSet then
  return {0, 0}
end

local newBonus = redis.call("INCRBY", bonusKey, bonusUnits)
redis.call("EXPIRE", bonusKey, ttlSeconds)

return {1, newBonus}
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
  const referralBonusKey = getFreeReferralBonusKey(userId);
  const result = (await redis.eval(
    CONSUME_FREE_REQUEST_UNITS_SCRIPT,
    [rateLimitKey, referralBonusKey],
    [requestLimit, requestCost, ttlMs],
  )) as [number | string, number | string];

  return {
    success: Number(result[0]) === 1,
    remaining: Math.max(0, Number(result[1])),
  };
};

export const grantFreeReferralBonusUnits = async (
  userId: string,
  units: number,
  idempotencyKey: string,
): Promise<{
  granted: boolean;
  units: number;
  alreadyGranted?: boolean;
  rateLimitSkipped?: boolean;
}> => {
  const bonusUnits = Math.max(0, Math.trunc(units));
  if (bonusUnits <= 0) {
    return { granted: false, units: 0 };
  }

  const redis = createRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV !== "production") {
      return { granted: true, units: bonusUnits, rateLimitSkipped: true };
    }
    return { granted: false, units: 0 };
  }

  const bonusKey = getFreeReferralBonusKey(userId);
  const grantKey = getFreeReferralBonusGrantKey(idempotencyKey);
  const result = (await redis.eval(
    GRANT_FREE_REFERRAL_BONUS_UNITS_SCRIPT,
    [bonusKey, grantKey],
    [bonusUnits, REFERRAL_BONUS_TTL_SECONDS],
  )) as [number | string, number | string];

  if (Number(result[0]) !== 1) {
    return { granted: false, units: 0, alreadyGranted: true };
  }

  return { granted: true, units: bonusUnits };
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
      throw new ChatSDKError(
        "rate_limit:chat",
        `You've used all your daily requests. Daily requests reset at midnight UTC.\n\nUpgrade plan for higher usage limits and more features.`,
        {
          resetTimestamp: reset,
          subscription: "free",
          capReason: "daily_requests_exhausted",
          ...getLimitPressureContext({
            subscription: "free",
            capReason: "daily_requests_exhausted",
          }),
        },
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
