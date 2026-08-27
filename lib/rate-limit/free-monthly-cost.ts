import { ChatSDKError } from "@/lib/errors";
import { getPostHogFeatureFlagVariantForUser } from "@/lib/posthog/server";
import {
  FREE_RECURRING_COST_LIMIT_USD_EXPERIMENT,
  getFreeMonthlyCostLimitDollars,
} from "./free-config";
import { POINTS_PER_DOLLAR } from "./token-bucket";
import { createRedisClient } from "./redis";
import { getLimitPressureContext } from "@/lib/limit-pressure";

const RECORD_FREE_MONTHLY_COST_SCRIPT = `
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

export const FREE_USAGE_BUDGET_EXPERIMENT_KEY = "free_usage_budget_v1";
export const FREE_USAGE_BUDGET_TREATMENT_VARIANT = "test";
const FREE_USAGE_BUDGET_MARKER_VERSION = "v1";

export interface FreeMonthlyCostSnapshot {
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

const freeUsageBudgetStartedKey = (userId: string) =>
  `free_usage_budget_started:${FREE_USAGE_BUDGET_MARKER_VERSION}:${userId}`;

async function getFreeMonthlyLimitDollars({
  redis,
  quotaSubject,
  userId,
  bucket,
}: {
  redis: NonNullable<ReturnType<typeof createRedisClient>>;
  quotaSubject: string;
  userId: string;
  bucket: string;
}): Promise<number> {
  const controlLimit = getFreeMonthlyCostLimitDollars();
  const variant = await getPostHogFeatureFlagVariantForUser(
    FREE_USAGE_BUDGET_EXPERIMENT_KEY,
    userId,
  );
  if (variant !== FREE_USAGE_BUDGET_TREATMENT_VARIANT) {
    return controlLimit;
  }

  const markerKey = freeUsageBudgetStartedKey(quotaSubject);
  try {
    let startedBucket = await redis.get<string>(markerKey);
    if (!startedBucket) {
      const didInitialize = await redis.set(markerKey, bucket, { nx: true });
      startedBucket =
        didInitialize === "OK" ? bucket : await redis.get(markerKey);
    }

    return startedBucket === bucket
      ? controlLimit
      : FREE_RECURRING_COST_LIMIT_USD_EXPERIMENT;
  } catch {
    // A marker failure must not unexpectedly tighten an existing user's cap.
    return controlLimit;
  }
}

const getLimitMessage = (reset: number) =>
  `You've used your free monthly usage. Free usage resets on ${new Date(
    reset,
  ).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })}. Upgrade for higher limits and more features.`;

export async function checkFreeMonthlyCostLimit(
  quotaSubject: string,
  userId = quotaSubject,
): Promise<FreeMonthlyCostSnapshot> {
  const { bucket, reset } = getCurrentUtcMonthWindow();
  const redis = createRedisClient();

  if (!redis) {
    const limitPoints = dollarsToPoints(getFreeMonthlyCostLimitDollars());
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

  const limitPoints = dollarsToPoints(
    await getFreeMonthlyLimitDollars({
      redis,
      quotaSubject,
      userId,
      bucket,
    }),
  );

  const usedPoints = Math.max(
    0,
    Number((await redis.get(freeMonthlyCostKey(quotaSubject, bucket))) ?? 0),
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
