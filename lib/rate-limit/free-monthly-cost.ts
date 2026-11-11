import { ChatSDKError } from "@/lib/errors";
import {
  type FreeLimitPolicy,
  getFreeMonthlyCostLimitDollars,
} from "./free-config";
import { POINTS_PER_DOLLAR } from "./token-bucket";
import { createRedisClient } from "./redis";
import {
  FREE_QUOTA_KEY_REDIRECT_SCRIPT,
  FREE_QUOTA_ADMISSION_GUARD_SCRIPT,
} from "./free-quota-migration";
import { getLimitPressureContext } from "@/lib/limit-pressure";

const RECORD_FREE_MONTHLY_COST_SCRIPT = `${FREE_QUOTA_KEY_REDIRECT_SCRIPT}
local key = KEYS[1]
local points = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])

if points <= 0 then
  return tonumber(redis.call("GET", key) or "0")
end

local nextUsed = redis.call("INCRBY", key, points)
if nextUsed == points then
  redis.call("PEXPIRE", key, ttlMs)
end

return nextUsed
`;

// A child can settle during every model step and again during finalization.
// Keep its cumulative total in Redis so retries only add the new cost, even
// when the response to an earlier write was lost or the month changes.
const RECORD_FREE_SUBAGENT_COST_SCRIPT = `${FREE_QUOTA_KEY_REDIRECT_SCRIPT}
local costKey = KEYS[1]
local runKey = KEYS[2]
local cumulativePoints = tonumber(ARGV[1])
local costTtlMs = tonumber(ARGV[2])
local runTtlMs = tonumber(ARGV[3])
local recordedPoints = tonumber(redis.call("GET", runKey) or "0")
local delta = math.max(0, cumulativePoints - recordedPoints)

if delta > 0 then
  redis.call("SET", runKey, cumulativePoints, "PX", runTtlMs)
  local usedPoints = redis.call("INCRBY", costKey, delta)
  redis.call("PEXPIRE", costKey, costTtlMs)
  return usedPoints
end

return tonumber(redis.call("GET", costKey) or "0")
`;

const SUBAGENT_COST_RECORD_TTL_MS = 32 * 24 * 60 * 60 * 1000;

export interface FreeMonthlyCostSnapshot {
  capReasonOnExhaustion?: import("@/lib/limit-pressure").LimitCapReason;
  budgetPeriod?: "daily" | "monthly";
  monthlyLimitPoints: number;
  monthlyRemainingAtStart: number;
  monthlyResetTime: Date;
  extraUsageEnabledAtStart: false;
  extraUsageHasBalanceAtStart: false;
  extraUsageBalanceAtStart: 0;
  extraUsageAutoReload: false;
  rateLimitSkipped?: boolean;
}

const dollarsToPoints = (dollars: number): number => {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0;
  return Math.ceil(dollars * POINTS_PER_DOLLAR);
};

const getCurrentUtcMonthWindow = () => {
  const now = new Date();
  const bucket = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);

  return {
    bucket,
    reset,
    ttlMs: Math.max(1, reset - now.getTime()),
  };
};

const freeMonthlyCostKey = (userId: string, bucket: string) =>
  `free_monthly_cost:${userId}:${bucket}`;

const getLimitMessage = (reset: number) =>
  `You've used your free monthly usage. Free usage resets on ${new Date(
    reset,
  ).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })}. Upgrade for higher limits and more features.`;

/** Enforce the configured monthly cost cap for a free quota subject. */
export async function checkFreeMonthlyCostLimit(
  quotaSubject: string,
  freeLimits?: FreeLimitPolicy,
): Promise<FreeMonthlyCostSnapshot> {
  const limitPoints = dollarsToPoints(
    getFreeMonthlyCostLimitDollars(freeLimits),
  );
  const { bucket, reset } = getCurrentUtcMonthWindow();
  const redis = createRedisClient();

  if (!redis) {
    if (process.env.NODE_ENV !== "production") {
      return {
        monthlyLimitPoints: limitPoints,
        monthlyRemainingAtStart: limitPoints,
        monthlyResetTime: new Date(reset),
        extraUsageEnabledAtStart: false,
        extraUsageHasBalanceAtStart: false,
        extraUsageBalanceAtStart: 0,
        extraUsageAutoReload: false,
        rateLimitSkipped: true,
      };
    }
    throw new ChatSDKError(
      "rate_limit:chat",
      "Rate limiting service is not configured",
    );
  }

  const usedPoints = Math.max(
    0,
    Number(
      (await redis.eval(
        `${FREE_QUOTA_ADMISSION_GUARD_SCRIPT}\n${FREE_QUOTA_KEY_REDIRECT_SCRIPT}\nreturn redis.call("GET", KEYS[1])`,
        [freeMonthlyCostKey(quotaSubject, bucket)],
        [],
      )) ?? 0,
    ),
  );
  const remainingPoints = Math.max(0, limitPoints - usedPoints);

  if (remainingPoints <= 0) {
    throw new ChatSDKError("rate_limit:chat", getLimitMessage(reset), {
      resetTimestamp: reset,
      subscription: "free",
      capReason: "free_monthly_exhausted",
      ...getLimitPressureContext({
        subscription: "free",
        capReason: "free_monthly_exhausted",
      }),
    });
  }

  return {
    monthlyLimitPoints: limitPoints,
    monthlyRemainingAtStart: remainingPoints,
    monthlyResetTime: new Date(reset),
    extraUsageEnabledAtStart: false,
    extraUsageHasBalanceAtStart: false,
    extraUsageBalanceAtStart: 0,
    extraUsageAutoReload: false,
  };
}

export async function recordFreeMonthlyCost(
  userId: string,
  costDollars: number,
): Promise<void> {
  const costPoints = dollarsToPoints(costDollars);
  if (costPoints <= 0) return;

  const redis = createRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV !== "production") return;
    throw new ChatSDKError(
      "rate_limit:chat",
      "Rate limiting service is not configured",
    );
  }

  const { bucket, ttlMs } = getCurrentUtcMonthWindow();
  await redis.eval(
    RECORD_FREE_MONTHLY_COST_SCRIPT,
    [freeMonthlyCostKey(userId, bucket)],
    [costPoints, ttlMs],
  );
}

/** Atomically record a free child's cumulative cost in the shared monthly pool. */
export async function recordFreeMonthlySubagentCost(
  quotaSubject: string,
  triggerRunId: string,
  cumulativeCostDollars: number,
  freeLimits?: FreeLimitPolicy,
): Promise<{ usedPoints: number; limitPoints: number }> {
  const limitPoints = dollarsToPoints(
    getFreeMonthlyCostLimitDollars(freeLimits),
  );
  const redis = createRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV !== "production") {
      return { usedPoints: 0, limitPoints };
    }
    throw new ChatSDKError(
      "rate_limit:chat",
      "Rate limiting service is not configured",
    );
  }

  const { bucket, ttlMs } = getCurrentUtcMonthWindow();
  const result = await redis.eval(
    RECORD_FREE_SUBAGENT_COST_SCRIPT,
    [
      freeMonthlyCostKey(quotaSubject, bucket),
      `free_monthly_subagent_cost:${quotaSubject}:${triggerRunId}`,
    ],
    [
      dollarsToPoints(cumulativeCostDollars),
      ttlMs,
      SUBAGENT_COST_RECORD_TTL_MS,
    ],
  );
  const usedPoints = Number(result);
  if (!Number.isSafeInteger(usedPoints) || usedPoints < 0) {
    throw new Error("Free subagent cost accounting returned an invalid total");
  }
  return { usedPoints, limitPoints };
}
