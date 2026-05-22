import { ChatSDKError } from "@/lib/errors";
import { POINTS_PER_DOLLAR } from "./token-bucket";
import { createRedisClient } from "./redis";

const FREE_MONTHLY_COST_LIMIT_USD_DEFAULT = 0.25;

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

export interface FreeMonthlyCostSnapshot {
  monthlyLimitPoints: number;
  monthlyRemainingAtStart: number;
  monthlyResetTime: Date;
  extraUsageBalanceAtStart: 0;
  extraUsageAutoReload: false;
  rateLimitSkipped?: boolean;
}

const getFreeMonthlyCostLimitDollars = (): number => {
  const configuredLimit = Number(process.env.FREE_MONTHLY_COST_LIMIT_USD);
  return Number.isFinite(configuredLimit) && configuredLimit > 0
    ? configuredLimit
    : FREE_MONTHLY_COST_LIMIT_USD_DEFAULT;
};

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

export async function checkFreeMonthlyCostLimit(
  userId: string,
): Promise<FreeMonthlyCostSnapshot> {
  const limitPoints = dollarsToPoints(getFreeMonthlyCostLimitDollars());
  const { bucket, reset } = getCurrentUtcMonthWindow();
  const redis = createRedisClient();

  if (!redis) {
    if (process.env.NODE_ENV !== "production") {
      return {
        monthlyLimitPoints: limitPoints,
        monthlyRemainingAtStart: limitPoints,
        monthlyResetTime: new Date(reset),
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
    Number((await redis.get(freeMonthlyCostKey(userId, bucket))) ?? 0),
  );
  const remainingPoints = Math.max(0, limitPoints - usedPoints);

  if (remainingPoints <= 0) {
    throw new ChatSDKError("rate_limit:chat", getLimitMessage(reset));
  }

  return {
    monthlyLimitPoints: limitPoints,
    monthlyRemainingAtStart: remainingPoints,
    monthlyResetTime: new Date(reset),
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
