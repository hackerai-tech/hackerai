import { ChatSDKError } from "@/lib/errors";
import {
  getPostHogFeatureFlagVariantForUser,
  phLogger,
} from "@/lib/posthog/server";
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
const FREE_USAGE_BUDGET_POLICY_VERSION = 1;

export type FreeUsageBudgetEnforcementSurface =
  "api_chat" | "trigger_agent_long" | "trigger_subagent";

type FreeUsageBudgetDecision = {
  limitDollars: number;
  variant: "control" | "test" | "unresolved";
  phase: "control" | "activation" | "recurring" | "safe_fallback";
  fallbackReason?: "variant_unresolved" | "marker_unavailable";
};

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

/** Resolve the assigned budget phase while preserving the $0.25 safe fallback. */
async function getFreeMonthlyBudgetDecision({
  redis,
  quotaSubject,
  userId,
  bucket,
}: {
  redis: NonNullable<ReturnType<typeof createRedisClient>>;
  quotaSubject: string;
  userId: string;
  bucket: string;
}): Promise<FreeUsageBudgetDecision> {
  const controlLimit = getFreeMonthlyCostLimitDollars();
  const variant = await getPostHogFeatureFlagVariantForUser(
    FREE_USAGE_BUDGET_EXPERIMENT_KEY,
    userId,
  );
  if (variant !== FREE_USAGE_BUDGET_TREATMENT_VARIANT) {
    return variant === "control"
      ? {
          limitDollars: controlLimit,
          variant: "control",
          phase: "control",
        }
      : {
          limitDollars: controlLimit,
          variant: "unresolved",
          phase: "safe_fallback",
          fallbackReason: "variant_unresolved",
        };
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
      ? {
          limitDollars: controlLimit,
          variant: "test",
          phase: "activation",
        }
      : {
          limitDollars: FREE_RECURRING_COST_LIMIT_USD_EXPERIMENT,
          variant: "test",
          phase: "recurring",
        };
  } catch {
    // A marker failure must not unexpectedly tighten an existing user's cap.
    return {
      limitDollars: controlLimit,
      variant: "test",
      phase: "safe_fallback",
      fallbackReason: "marker_unavailable",
    };
  }
}

/** Identify the deployed revision used to reconcile API and Trigger workers. */
const getServiceVersion = () =>
  (
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GITHUB_SHA ??
    process.env.TRIGGER_VERSION ??
    "dev"
  ).slice(0, 64);

/** Emit one privacy-safe policy decision for cross-surface reconciliation. */
const captureFreeUsageBudgetEnforcement = ({
  userId,
  surface,
  bucket,
  decision,
  limitPoints,
  usedPoints,
  remainingPoints,
}: {
  userId: string;
  surface: FreeUsageBudgetEnforcementSurface;
  bucket: string;
  decision: FreeUsageBudgetDecision;
  limitPoints: number;
  usedPoints: number;
  remainingPoints: number;
}) => {
  phLogger.event("free_usage_budget_enforcement", {
    userId,
    experiment_key: FREE_USAGE_BUDGET_EXPERIMENT_KEY,
    policy_version: FREE_USAGE_BUDGET_POLICY_VERSION,
    service_version: getServiceVersion(),
    enforcement_surface: surface,
    enforcement_result: remainingPoints > 0 ? "allowed" : "blocked",
    variant: decision.variant,
    budget_phase: decision.phase,
    budget_month: bucket,
    monthly_limit_dollars: limitPoints / POINTS_PER_DOLLAR,
    monthly_used_dollars: usedPoints / POINTS_PER_DOLLAR,
    monthly_remaining_dollars: remainingPoints / POINTS_PER_DOLLAR,
    ...(decision.fallbackReason && {
      fallback_reason: decision.fallbackReason,
    }),
  });
};

const getLimitMessage = (reset: number) =>
  `You've used your free monthly usage. Free usage resets on ${new Date(
    reset,
  ).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })}. Upgrade for higher limits and more features.`;

/**
 * Enforce the free monthly cost cap and optionally emit one initial-preflight
 * decision for cross-surface experiment monitoring.
 */
export async function checkFreeMonthlyCostLimit(
  quotaSubject: string,
  userId = quotaSubject,
  // Supply a surface only for the initial preflight. Durable rechecks omit it
  // so this temporary experiment telemetry emits once per worker execution.
  enforcementSurface?: FreeUsageBudgetEnforcementSurface,
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

  const budgetDecision = await getFreeMonthlyBudgetDecision({
    redis,
    quotaSubject,
    userId,
    bucket,
  });
  const limitPoints = dollarsToPoints(budgetDecision.limitDollars);

  const usedPoints = Math.max(
    0,
    Number((await redis.get(freeMonthlyCostKey(quotaSubject, bucket))) ?? 0),
  );
  const remainingPoints = Math.max(0, limitPoints - usedPoints);

  if (enforcementSurface) {
    captureFreeUsageBudgetEnforcement({
      userId,
      surface: enforcementSurface,
      bucket,
      decision: budgetDecision,
      limitPoints,
      usedPoints,
      remainingPoints,
    });
  }

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
