import { Ratelimit } from "@upstash/ratelimit";
import { ChatSDKError } from "@/lib/errors";
import type {
  SubscriptionTier,
  RateLimitInfo,
  ExtraUsageConfig,
} from "@/types";
import { createRedisClient, formatTimeRemaining } from "./redis";
import {
  deductFromBalance,
  refundToBalance,
  deductFromTeamBalance,
  refundToTeamBalance,
  type DeductBalanceResult,
} from "@/lib/extra-usage";
import { getSuspensionMessage } from "@/lib/suspensionMessage";
import {
  getLimitPressureContext,
  type LimitCapReason,
} from "@/lib/limit-pressure";
import { isUserRateLimitKey } from "./key-cleanup";

export { isUserRateLimitKey } from "./key-cleanup";

// =============================================================================
// Configuration
// =============================================================================

/** Model pricing: $/1M tokens per model. */
const MODEL_PRICING_MAP: Record<string, { input: number; output: number }> = {
  default: { input: 0.5, output: 3.0 },
  "model-sonnet-4.6": { input: 3.0, output: 15.0 },
  // Grok 4.5 rates from OpenRouter: $2.00 in / $6.00 out per 1M tokens.
  "model-grok-4.5": { input: 2.0, output: 6.0 },
  "model-grok-4.5-pro": { input: 2.0, output: 6.0 },
  "model-gemini-3-flash": { input: 2.0, output: 6.0 },
  // Rates from OpenRouter: $0.09 in / $0.18 out per 1M tokens.
  "agent-model-free": { input: 0.09, output: 0.18 },
  "model-deepseek-v4-pro": { input: 0.435, output: 0.87 },
  "fallback-grok-4.5": { input: 2.0, output: 6.0 },
  "model-opus-4.6": { input: 5.0, output: 25.0 },
  // Rates from OpenRouter: $0.9086 in / $2.856 out per 1M tokens.
  "model-glm-5.2": { input: 0.9086, output: 2.856 },
  // These keys route to minimax/minimax-m3 via lib/ai/providers.ts.
  // Rates from OpenRouter: $0.30 in / $1.20 out per 1M tokens.
  "ask-model": { input: 0.3, output: 1.2 },
  "agent-model": { input: 0.3, output: 1.2 },
  "model-minimax-m3": { input: 0.3, output: 1.2 },
  // Kimi keys are retained as compatibility aliases for stale persisted routes.
  // Rates from OpenRouter: $0.95 in / $4.00 out per 1M tokens.
  "model-kimi-k2.7-code": { input: 0.95, output: 4.0 },
  "model-kimi-k2.6": { input: 0.95, output: 4.0 },
};

const getModelPricing = (modelName?: string) =>
  (modelName && MODEL_PRICING_MAP[modelName]) || MODEL_PRICING_MAP.default;

/** Points per dollar (1 point = $0.0001) */
export const POINTS_PER_DOLLAR = 10_000;

/**
 * Normal usage pricing multiplier — covers additional operational costs
 * (infrastructure, overhead, etc.) on top of raw model pricing.
 * This is baked into the point cost so it depletes the subscription bucket
 * faster; it is NOT subtracted from the user's subscription credit balance.
 */
export const NORMAL_USAGE_MULTIPLIER = 1.4;

/** Convert raw provider/tool spend into billable user-balance points. */
export const billableCostDollarsToPoints = (costDollars: number): number =>
  Number.isFinite(costDollars) && costDollars > 0
    ? Math.max(
        1,
        Math.ceil(
          Number(
            (costDollars * POINTS_PER_DOLLAR * NORMAL_USAGE_MULTIPLIER).toFixed(
              6,
            ),
          ),
        ),
      )
    : 0;

/** 30 days in seconds — used for Redis TTLs aligned with billing cycles. */
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const REDIS_SCAN_COUNT = 500;
const REDIS_DELETE_BATCH_SIZE = 100;
const RATE_LIMIT_SERVICE_NOT_CONFIGURED =
  "Rate limiting service is not configured";

const throwRateLimitServiceNotConfigured = (): never => {
  throw new ChatSDKError("rate_limit:chat", RATE_LIMIT_SERVICE_NOT_CONFIGURED);
};

type RedisClient = NonNullable<ReturnType<typeof createRedisClient>>;

export type UsageDeductionFailureReason =
  | "extra_usage_unavailable"
  | "insufficient_funds"
  | "monthly_cap_exceeded"
  | "member_cap_exceeded"
  | "member_disabled"
  | "pool_disabled"
  | "auto_reload_failed"
  | "deduction_failed";

export interface UsageDeductionResult {
  includedPointsDeducted: number;
  extraUsagePointsDeducted: number;
  uncoveredPoints: number;
  usageDeductionFailed: boolean;
  usageDeductionFailureReason?: UsageDeductionFailureReason;
}

const emptyUsageDeductionResult = (): UsageDeductionResult => ({
  includedPointsDeducted: 0,
  extraUsagePointsDeducted: 0,
  uncoveredPoints: 0,
  usageDeductionFailed: false,
});

const nonNegativePoints = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;

const finiteNonNegativePoints = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;

const getDeductionFailureReason = (
  result: DeductBalanceResult,
): UsageDeductionFailureReason => {
  if (result.monthlyCapExceeded) return "monthly_cap_exceeded";
  if (result.memberCapExceeded) return "member_cap_exceeded";
  if (result.memberDisabled) return "member_disabled";
  if (result.poolDisabled) return "pool_disabled";
  if (result.autoReloadResult?.success === false) return "auto_reload_failed";
  if (result.insufficientFunds) return "insufficient_funds";
  return "deduction_failed";
};

type MonthlyLimiter = {
  limiter: {
    limit: (
      key: string,
      options?: { rate?: number },
    ) => Promise<{ remaining: number; reset: number; success?: boolean }>;
  };
  key: string;
};

const deductAdditionalUsagePoints = async ({
  monthly,
  userId,
  subscription,
  additionalCostPoints,
  extraUsageConfig,
  organizationId,
  usageSettlementId,
}: {
  monthly: MonthlyLimiter;
  userId: string;
  subscription: SubscriptionTier;
  additionalCostPoints: number;
  extraUsageConfig?: ExtraUsageConfig;
  organizationId?: string;
  usageSettlementId?: string;
}): Promise<UsageDeductionResult> => {
  const normalizedAdditionalCost = nonNegativePoints(additionalCostPoints);
  if (normalizedAdditionalCost <= 0) return emptyUsageDeductionResult();

  const buildDeltaResult = (
    includedPointsDeducted: number = 0,
    extraUsagePointsDeducted: number = 0,
    failureReason?: UsageDeductionFailureReason,
  ): UsageDeductionResult => {
    const coveredPoints =
      nonNegativePoints(includedPointsDeducted) +
      nonNegativePoints(extraUsagePointsDeducted);
    const uncoveredPoints = Math.max(
      0,
      normalizedAdditionalCost - coveredPoints,
    );
    return {
      includedPointsDeducted: nonNegativePoints(includedPointsDeducted),
      extraUsagePointsDeducted: nonNegativePoints(extraUsagePointsDeducted),
      uncoveredPoints,
      usageDeductionFailed: uncoveredPoints > 0 || !!failureReason,
      ...(failureReason && { usageDeductionFailureReason: failureReason }),
    };
  };

  const peekResult = await monthly.limiter.limit(monthly.key, { rate: 0 });
  const available = Math.max(0, peekResult.remaining);
  const fromBucket = Math.min(normalizedAdditionalCost, available);
  let includedDeducted = 0;

  if (fromBucket > 0) {
    const bucketResult = await monthly.limiter.limit(monthly.key, {
      rate: fromBucket,
    });
    if (bucketResult.success !== false) {
      includedDeducted = fromBucket;
    }
  }

  const fromExtraUsage = normalizedAdditionalCost - includedDeducted;
  let extraUsageDeducted = 0;
  let failureReason: UsageDeductionFailureReason | undefined;

  if (fromExtraUsage > 0) {
    if (
      extraUsageConfig?.enabled &&
      (extraUsageConfig.hasBalance || extraUsageConfig.autoReloadEnabled)
    ) {
      const isTeamPool = subscription === "team" && !!organizationId;
      const deductResult = await (async () => {
        try {
          return isTeamPool
            ? await deductFromTeamBalance(
                organizationId!,
                userId,
                fromExtraUsage,
                usageSettlementId,
              )
            : await deductFromBalance(
                userId,
                fromExtraUsage,
                usageSettlementId,
              );
        } catch (error) {
          console.error("Failed to deduct extra usage delta:", error);
          return {
            success: false,
            newBalanceDollars: 0,
            insufficientFunds: false,
            monthlyCapExceeded: false,
          };
        }
      })();
      if (deductResult.success) {
        extraUsageDeducted = fromExtraUsage;
      } else {
        failureReason = getDeductionFailureReason(deductResult);
      }
    } else {
      failureReason = "extra_usage_unavailable";
    }
  }

  return buildDeltaResult(includedDeducted, extraUsageDeducted, failureReason);
};

const scanRedisKeys = async (
  redis: RedisClient,
  pattern: string,
): Promise<string[]> => {
  let cursor = "0";
  const keys: string[] = [];

  do {
    const [nextCursor, batch] = await redis.scan(cursor, {
      match: pattern,
      count: REDIS_SCAN_COUNT,
    });
    keys.push(...batch);
    cursor = nextCursor;
  } while (cursor !== "0");

  return keys;
};

const deleteRedisKeys = async (
  redis: RedisClient,
  keys: string[],
): Promise<void> => {
  for (let index = 0; index < keys.length; index += REDIS_DELETE_BATCH_SIZE) {
    await redis.del(...keys.slice(index, index + REDIS_DELETE_BATCH_SIZE));
  }
};

// =============================================================================
// Cost Calculation
// =============================================================================

/**
 * Calculate point cost for tokens.
 * @param tokens - Number of tokens
 * @param type - "input" or "output"
 * @param modelName - Optional model name for model-specific pricing
 */
export const calculateTokenCost = (
  tokens: number,
  type: "input" | "output",
  modelName?: string,
): number => {
  if (tokens <= 0) return 0;
  const pricing = getModelPricing(modelName);
  const price = type === "input" ? pricing.input : pricing.output;
  return Math.ceil(
    (tokens / 1_000_000) * price * POINTS_PER_DOLLAR * NORMAL_USAGE_MULTIPLIER,
  );
};

/**
 * Estimate raw model cost for analytics/reporting only.
 * Unlike calculateTokenCost, this intentionally excludes the normal usage
 * multiplier so unit economics reflects provider-priced usage cost.
 */
export const calculateRawTokenCost = (
  tokens: number,
  type: "input" | "output",
  modelName?: string,
): number => {
  if (tokens <= 0) return 0;
  const pricing = getModelPricing(modelName);
  const price = type === "input" ? pricing.input : pricing.output;
  return Math.ceil((tokens / 1_000_000) * price * POINTS_PER_DOLLAR);
};

// =============================================================================
// Budget Limits
// =============================================================================

/** Monthly credit amounts per tier (1:1 with subscription price) */
const MONTHLY_CREDITS: Record<string, number> = {
  free: 0,
  pro: 250_000, // $25
  "pro-plus": 600_000, // $60
  ultra: 2_000_000, // $200
  team: 400_000, // $40
};

/**
 * Get monthly budget limit for a subscription tier (shared between agent and ask modes).
 * @returns { monthly: monthly budget in points }
 */
export const getBudgetLimits = (
  subscription: SubscriptionTier,
): { monthly: number } => {
  return { monthly: MONTHLY_CREDITS[subscription] ?? 0 };
};

/** Get monthly budget in dollars (full subscription price, shared between modes) */
export const getSubscriptionPrice = (
  subscription: SubscriptionTier,
): number => {
  return (MONTHLY_CREDITS[subscription] ?? 0) / POINTS_PER_DOLLAR;
};

// =============================================================================
// Rate Limiting
// =============================================================================

/** Build the Redis key used by the monthly token bucket. */
export const getMonthlyBucketKey = (userId: string, tier: SubscriptionTier) =>
  `usage:monthly:${userId}:${tier}`;

const normalizeCycleAllocation = (
  tierMax: number,
  requestedAllocation?: number,
): number => {
  const normalized = finiteNonNegativePoints(requestedAllocation);
  return normalized === null ? tierMax : Math.min(tierMax, normalized);
};

const getStoredCycleAllocation = async (
  redis: RedisClient,
  monthlyKey: string,
  tierMax: number,
): Promise<number | null> => {
  const stored = finiteNonNegativePoints(
    await redis.hget(monthlyKey, "cycleAllocation"),
  );
  return stored === null ? null : Math.min(tierMax, stored);
};

const ENFORCE_CYCLE_ALLOCATION_SCRIPT = `
local key = KEYS[1]
local tokens = tonumber(redis.call("HGET", key, "tokens"))
local allocation = tonumber(redis.call("HGET", key, "cycleAllocation"))

if not tokens or not allocation then
  return {-1, -1, 0}
end

local remaining = math.max(0, math.min(tokens, allocation))
if remaining < tokens then
  redis.call("HSET", key, "tokens", remaining)
end

return {remaining, allocation, tokens - remaining}
`;

const CAP_CYCLE_ALLOCATION_SCRIPT = `
local key = KEYS[1]
local requestedAllocation = tonumber(ARGV[1])
local tierMax = tonumber(ARGV[2])
local targetRefilledAt = tonumber(ARGV[3])

local currentTokens = tonumber(redis.call("HGET", key, "tokens")) or tierMax
local previousAllocation = tonumber(redis.call("HGET", key, "cycleAllocation")) or tierMax
local targetAllocation = math.min(previousAllocation, requestedAllocation)
local previousRemaining = math.max(0, math.min(previousAllocation, currentTokens))
local consumed = math.max(0, previousAllocation - previousRemaining)
local targetRemaining = math.max(0, targetAllocation - consumed)
local pointsRemoved = math.max(0, currentTokens - targetRemaining)

if targetRefilledAt >= 0 then
  redis.call(
    "HSET",
    key,
    "tokens", targetRemaining,
    "cycleAllocation", targetAllocation,
    "cycleTierMax", tierMax,
    "refilledAt", targetRefilledAt
  )
else
  redis.call(
    "HSET",
    key,
    "tokens", targetRemaining,
    "cycleAllocation", targetAllocation,
    "cycleTierMax", tierMax
  )
end

return {
  previousAllocation,
  math.max(0, currentTokens),
  targetAllocation,
  targetRemaining,
  pointsRemoved
}
`;

const enforceStoredCycleAllocation = async (
  redis: RedisClient,
  monthlyKey: string,
  tierMax: number,
): Promise<{ allocation: number; remaining: number } | null> => {
  const [remaining, allocation] = await redis.eval<
    [],
    [number, number, number]
  >(ENFORCE_CYCLE_ALLOCATION_SCRIPT, [monthlyKey], []);
  const normalizedAllocation = finiteNonNegativePoints(allocation);
  const normalizedRemaining = finiteNonNegativePoints(remaining);
  if (normalizedAllocation === null || normalizedRemaining === null)
    return null;
  const cappedAllocation = Math.min(tierMax, normalizedAllocation);
  return {
    allocation: cappedAllocation,
    remaining: Math.min(cappedAllocation, normalizedRemaining),
  };
};

export const getCycleExpireSeconds = (
  periodEndSeconds?: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): number => {
  if (
    !periodEndSeconds ||
    !Number.isFinite(periodEndSeconds) ||
    periodEndSeconds <= nowSeconds
  ) {
    return THIRTY_DAYS_SECONDS;
  }

  // Keep display metadata alive through 31-day billing periods and webhook lag.
  const oneDayBufferSeconds = 24 * 60 * 60;
  return Math.max(
    THIRTY_DAYS_SECONDS,
    Math.ceil(periodEndSeconds - nowSeconds + oneDayBufferSeconds),
  );
};

/**
 * Create rate limiter for a user (shared between agent and ask modes).
 * Single monthly bucket replacing the old session+weekly dual buckets.
 */
const createRateLimiter = (
  redis: ReturnType<typeof createRedisClient>,
  userId: string,
  subscription: SubscriptionTier,
) => {
  const { monthly: monthlyLimit } = getBudgetLimits(subscription);

  return {
    monthlyLimit,
    monthly: {
      limiter: new Ratelimit({
        redis: redis!,
        limiter: Ratelimit.tokenBucket(monthlyLimit, "30 d", monthlyLimit),
        prefix: "usage:monthly",
      }),
      key: `${userId}:${subscription}`,
    },
  };
};

/**
 * Check rate limit using token bucket and deduct estimated input cost upfront.
 * Used for all paid users (Pro, Pro+, Ultra, Team) in both agent and ask modes.
 * Supports extra usage charging when limit is exceeded.
 */
export const checkTokenBucketLimit = async (
  userId: string,
  subscription: SubscriptionTier,
  estimatedInputTokens: number = 0,
  extraUsageConfig?: ExtraUsageConfig,
  modelName?: string,
  organizationId?: string,
): Promise<RateLimitInfo> => {
  const redis = createRedisClient();

  if (!redis) {
    if (process.env.NODE_ENV === "production") {
      throwRateLimitServiceNotConfigured();
    }

    // Skip rate limiting if Redis is not configured in local dev/test.
    const { monthly } = getBudgetLimits(subscription);
    return {
      remaining: monthly,
      resetTime: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      limit: monthly,
      rateLimitSkipped: true,
    };
  }

  try {
    // For team users: detect new bucket so we can apply seat debt after creation
    if (subscription === "team" && !organizationId) {
      console.warn(
        `[checkTokenBucketLimit] Team user ${userId} missing organizationId — seat debt enforcement skipped`,
      );
    }
    const isNewTeamBucket =
      subscription === "team" &&
      organizationId &&
      !(await redis.exists(getMonthlyBucketKey(userId, "team")));

    const { monthly, monthlyLimit } = createRateLimiter(
      redis,
      userId,
      subscription,
    );

    if (subscription === "free" || monthlyLimit === 0) {
      throw new ChatSDKError(
        "rate_limit:chat",
        "Cloud sandbox is not available on the free tier. Use a local sandbox or upgrade to Pro.",
      );
    }

    const estimatedCost = calculateTokenCost(
      estimatedInputTokens,
      "input",
      modelName,
    );

    const upgradeHint =
      subscription === "pro"
        ? " or upgrade to Pro+ or Ultra for higher limits"
        : subscription === "pro-plus"
          ? " or upgrade to Ultra for higher limits"
          : "";
    const continueWithCreditsHint =
      subscription === "team"
        ? "Ask your team admin to add team extra usage credits to keep going now."
        : `To keep going now, add extra usage credits in Settings${upgradeHint}.`;
    const emptyCreditsHint =
      subscription === "team"
        ? "your team's extra usage balance is empty"
        : "your extra usage balance is empty";
    const limitMetadata = (
      reset: number,
      capReason: LimitCapReason,
      extra: Record<string, unknown> = {},
    ) => ({
      resetTimestamp: reset,
      subscription,
      capReason,
      extraUsageEnabled: extraUsageConfig?.enabled ?? false,
      extraUsageHasBalance: extraUsageConfig?.hasBalance ?? false,
      extraUsageAutoReloadEnabled: extraUsageConfig?.autoReloadEnabled ?? false,
      ...(extraUsageConfig?.balanceDollars !== undefined && {
        extraUsageBalanceDollars: extraUsageConfig.balanceDollars,
      }),
      ...(extraUsageConfig?.monthlyCapDollars !== undefined && {
        extraUsageMonthlyCapDollars: extraUsageConfig.monthlyCapDollars,
      }),
      ...(extraUsageConfig?.monthlySpentDollars !== undefined && {
        extraUsageMonthlySpentDollars: extraUsageConfig.monthlySpentDollars,
      }),
      ...(extraUsageConfig?.monthlyRemainingDollars !== undefined && {
        extraUsageMonthlyRemainingDollars:
          extraUsageConfig.monthlyRemainingDollars,
      }),
      ...getLimitPressureContext({ subscription, capReason }),
      ...extra,
    });

    const monthlyLimitError = (reset: number) => {
      const resetTime = formatTimeRemaining(new Date(reset));
      return new ChatSDKError(
        "rate_limit:chat",
        `You've hit your monthly usage limit.\n\nYour limit resets ${resetTime}. ${continueWithCreditsHint}`,
        limitMetadata(reset, "monthly_exhausted"),
      );
    };

    let effectiveMonthlyLimit = monthlyLimit;

    // Helper to build RateLimitInfo from a limiter result
    const buildResult = (
      result: { remaining: number; reset: number },
      pointsDeducted: number,
      extraUsagePointsDeducted?: number,
    ): RateLimitInfo => ({
      remaining: result.remaining,
      resetTime: new Date(result.reset),
      limit: effectiveMonthlyLimit,
      monthly: {
        remaining: result.remaining,
        limit: effectiveMonthlyLimit,
        resetTime: new Date(result.reset),
      },
      pointsDeducted,
      ...(extraUsagePointsDeducted !== undefined && {
        extraUsagePointsDeducted,
      }),
    });

    // Step 1: Check limit WITHOUT deducting (rate: 0 peeks at current state)
    let monthlyCheck = await monthly.limiter.limit(monthly.key, { rate: 0 });

    // Step 1.5: For new team members, apply seat debt from removed members
    if (isNewTeamBucket) {
      await applyTeamSeatDebt(userId, organizationId!);
      // Re-peek after debt burn to get accurate remaining
      monthlyCheck = await monthly.limiter.limit(monthly.key, { rate: 0 });
    }

    // Price-specific and prorated cycles store their authoritative allowance
    // in the bucket. Re-apply the cap if Upstash's 30-day refill races ahead
    // of the Stripe renewal webhook.
    const monthlyStorageKey = getMonthlyBucketKey(userId, subscription);
    const enforcedCycleAllocation = await enforceStoredCycleAllocation(
      redis,
      monthlyStorageKey,
      monthlyLimit,
    );
    if (enforcedCycleAllocation) {
      effectiveMonthlyLimit = enforcedCycleAllocation.allocation;
      monthlyCheck = {
        ...monthlyCheck,
        remaining: enforcedCycleAllocation.remaining,
      };
    }

    // Step 2: Check if we have enough capacity, or if we need extra usage
    const shortfall = Math.max(0, estimatedCost - monthlyCheck.remaining);

    // If we're over limit, try extra usage (prepaid balance)
    if (shortfall > 0) {
      if (
        extraUsageConfig?.enabled &&
        (extraUsageConfig.hasBalance || extraUsageConfig.autoReloadEnabled)
      ) {
        // Team users draw from the org's shared pool with per-member caps;
        // everyone else hits their personal balance.
        const isTeamPool = subscription === "team" && !!organizationId;
        const deductResult = isTeamPool
          ? await deductFromTeamBalance(organizationId!, userId, shortfall)
          : await deductFromBalance(userId, shortfall);

        if (deductResult.success) {
          // Extra usage covered the shortfall. Deduct only what subscription contributed.
          const bucketDeduct = estimatedCost - shortfall;

          const monthlyResult = await monthly.limiter.limit(monthly.key, {
            rate: bucketDeduct,
          });

          if (!monthlyResult.success) {
            try {
              if (isTeamPool) {
                await refundToTeamBalance(organizationId!, userId, shortfall);
              } else {
                await refundToBalance(userId, shortfall);
              }
            } catch (refundError) {
              console.error(
                "[checkTokenBucketLimit] Failed to refund extra usage after bucket debit failed:",
                refundError,
              );
            }
            throw monthlyLimitError(monthlyResult.reset);
          }

          return buildResult(monthlyResult, bucketDeduct, shortfall);
        }

        // Deduction failed - check why
        if (deductResult.insufficientFunds) {
          const resetTime = formatTimeRemaining(new Date(monthlyCheck.reset));

          // Team-pool specific: admin disabled this member's pool access.
          if (deductResult.memberDisabled) {
            const msg = `Your team admin has paused your access to team extra usage. Ask them to re-enable it to continue beyond your subscription limit.`;
            throw new ChatSDKError(
              "rate_limit:chat",
              msg,
              limitMetadata(monthlyCheck.reset, "team_member_disabled"),
            );
          }

          // Team-pool specific: admin disabled the pool entirely.
          if (deductResult.poolDisabled) {
            const msg = `Your team's extra usage pool is disabled.\n\nYour subscription limit resets ${resetTime}. Ask your team admin to enable team extra usage to continue.`;
            throw new ChatSDKError(
              "rate_limit:chat",
              msg,
              limitMetadata(monthlyCheck.reset, "team_pool_disabled"),
            );
          }

          // Team-pool specific: this member hit their per-member monthly cap.
          if (deductResult.memberCapExceeded) {
            const msg = `You've hit your team-set monthly spending limit.\n\nYour limit resets ${resetTime}. Ask your team admin to raise your limit to continue.`;
            throw new ChatSDKError(
              "rate_limit:chat",
              msg,
              limitMetadata(monthlyCheck.reset, "team_member_cap"),
            );
          }

          if (deductResult.monthlyCapExceeded) {
            const msg = `You've hit your monthly extra usage spending limit.\n\nYour limit resets ${resetTime}. To keep going now, increase your spending limit in Settings.`;
            throw new ChatSDKError(
              "rate_limit:chat",
              msg,
              limitMetadata(monthlyCheck.reset, "extra_usage_cap"),
            );
          }

          // If we tried auto-reload and Stripe declined the card, give the
          // user a precise message naming the decline reason instead of the
          // generic "balance is empty" copy. Checked AFTER the cap branches
          // so capped users still see the cap message (deductPoints returns
          // insufficientFunds: true alongside the cap flags).
          if (
            deductResult.autoReloadTriggered &&
            deductResult.autoReloadResult &&
            deductResult.autoReloadResult.success === false
          ) {
            const reason =
              deductResult.autoReloadResult.reason ?? "payment_failed";
            // Suspended customers (flagged by the fraud webhook) short-circuit
            // before any charge attempt. Render the suspension message instead
            // of the "update your payment method" copy — they can't fix it.
            const msg =
              reason === "customer_blocked"
                ? getSuspensionMessage(null)
                : `Auto-reload couldn't charge your card (${reason}). Update your payment method in Settings, then try again.`;
            throw new ChatSDKError("rate_limit:chat", msg, {
              ...limitMetadata(monthlyCheck.reset, "auto_reload_failed", {
                autoReloadFailed: true,
                autoReloadFailureReason: reason,
              }),
            });
          }

          const msg = `You've hit your usage limit and ${emptyCreditsHint}.\n\nYour limit resets ${resetTime}. ${continueWithCreditsHint}`;
          throw new ChatSDKError(
            "rate_limit:chat",
            msg,
            limitMetadata(monthlyCheck.reset, "monthly_exhausted"),
          );
        }

        // Deduction failed for a service reason (not insufficient funds) —
        // tell the user to retry instead of a misleading "add credits" message.
        throw new ChatSDKError(
          "rate_limit:chat",
          "Extra usage billing is temporarily unavailable. Please try again in a few moments.",
          limitMetadata(monthlyCheck.reset, "billing_unavailable"),
        );
      }

      // No extra usage enabled - throw standard rate limit error
      const resetTime = formatTimeRemaining(new Date(monthlyCheck.reset));
      const msg = `You've hit your monthly usage limit.\n\nYour limit resets ${resetTime}. ${continueWithCreditsHint}`;
      throw new ChatSDKError(
        "rate_limit:chat",
        msg,
        limitMetadata(monthlyCheck.reset, "monthly_exhausted"),
      );
    }

    // Step 3: Have capacity, deduct from monthly bucket
    const monthlyResult = await monthly.limiter.limit(monthly.key, {
      rate: estimatedCost,
    });

    if (!monthlyResult.success) {
      throw monthlyLimitError(monthlyResult.reset);
    }

    return buildResult(monthlyResult, estimatedCost);
  } catch (error) {
    if (error instanceof ChatSDKError) throw error;
    throw new ChatSDKError(
      "rate_limit:chat",
      `Rate limiting service unavailable: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
};

/**
 * Deduct an already-computed usage delta. Used for selective mid-run Agent
 * settlement after a provider step has reported actual usage.
 */
export const deductUsageDelta = async (
  userId: string,
  subscription: SubscriptionTier,
  additionalCostPoints: number,
  extraUsageConfig?: ExtraUsageConfig,
  organizationId?: string,
  usageSettlementId?: string,
): Promise<UsageDeductionResult> => {
  const redis = createRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV !== "production") {
      return emptyUsageDeductionResult();
    }
    throwRateLimitServiceNotConfigured();
  }

  try {
    const { monthly, monthlyLimit } = createRateLimiter(
      redis,
      userId,
      subscription,
    );
    if (monthlyLimit === 0) return emptyUsageDeductionResult();

    return deductAdditionalUsagePoints({
      monthly,
      userId,
      subscription,
      additionalCostPoints,
      extraUsageConfig,
      organizationId,
      usageSettlementId,
    });
  } catch (error) {
    console.error("Failed to deduct usage delta:", error);
    return {
      ...emptyUsageDeductionResult(),
      uncoveredPoints: nonNegativePoints(additionalCostPoints),
      usageDeductionFailed: nonNegativePoints(additionalCostPoints) > 0,
      usageDeductionFailureReason: "deduction_failed",
    };
  }
};

/**
 * Deduct additional cost after processing (output + any input difference).
 * If extra usage was used for input (bucket at 0), also deducts output from extra usage.
 * If we over-estimated input cost, refunds the difference back to the bucket.
 *
 * @param providerCostDollars - If provided (from authoritative provider cost),
 *   uses this instead of token calculation. On clean completions this includes
 *   model + sandbox + tool costs.
 *   On non-clean completions this is undefined; nonModelCostDollars covers sandbox/tool costs.
 * @param nonModelCostDollars - Sandbox session and tool costs (always accurate). When providerCostDollars
 *   is undefined (non-clean streams), this is added on top of token-based model cost.
 */
export const deductUsage = async (
  userId: string,
  subscription: SubscriptionTier,
  estimatedInputTokens: number,
  actualInputTokens: number,
  actualOutputTokens: number,
  extraUsageConfig?: ExtraUsageConfig,
  providerCostDollars?: number,
  modelName?: string,
  nonModelCostDollars: number = 0,
  organizationId?: string,
  initialDeduction?: Pick<
    RateLimitInfo,
    "pointsDeducted" | "extraUsagePointsDeducted"
  >,
  actualModelName?: string,
  usageSettlementId?: string,
): Promise<UsageDeductionResult> => {
  const redis = createRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV !== "production") {
      return emptyUsageDeductionResult();
    }
    throwRateLimitServiceNotConfigured();
  }

  let lastKnownDeductionResult = emptyUsageDeductionResult();
  let actualCostPoints = 0;

  const withFinalCoverage = (
    result: UsageDeductionResult,
    failureReason?: UsageDeductionResult["usageDeductionFailureReason"],
  ): UsageDeductionResult => {
    const coveredPoints =
      result.includedPointsDeducted + result.extraUsagePointsDeducted;
    const uncoveredPoints = Math.max(0, actualCostPoints - coveredPoints);
    return {
      ...result,
      uncoveredPoints,
      usageDeductionFailed: uncoveredPoints > 0 || !!failureReason,
      ...(failureReason && { usageDeductionFailureReason: failureReason }),
    };
  };

  try {
    const { monthly, monthlyLimit } = createRateLimiter(
      redis,
      userId,
      subscription,
    );
    if (monthlyLimit === 0) return emptyUsageDeductionResult();

    // Calculate estimated input cost (already deducted upfront)
    const estimatedInputCost = calculateTokenCost(
      estimatedInputTokens,
      "input",
      modelName,
    );
    const initialIncludedPoints = nonNegativePoints(
      initialDeduction?.pointsDeducted ?? estimatedInputCost,
    );
    const initialExtraUsagePoints = nonNegativePoints(
      initialDeduction?.extraUsagePointsDeducted,
    );
    const buildDeductionResult = (
      includedDeltaPoints: number = 0,
      extraUsageDeltaPoints: number = 0,
      includedRefundPoints: number = 0,
      extraUsageRefundPoints: number = 0,
    ): UsageDeductionResult => ({
      includedPointsDeducted: Math.max(
        0,
        initialIncludedPoints +
          nonNegativePoints(includedDeltaPoints) -
          nonNegativePoints(includedRefundPoints),
      ),
      extraUsagePointsDeducted: Math.max(
        0,
        initialExtraUsagePoints +
          nonNegativePoints(extraUsageDeltaPoints) -
          nonNegativePoints(extraUsageRefundPoints),
      ),
      uncoveredPoints: 0,
      usageDeductionFailed: false,
    });
    lastKnownDeductionResult = buildDeductionResult();

    // Calculate actual billable cost - prefer provider cost if available.
    // Provider cost already includes non-model costs (sandbox/tools) when present.
    // When absent (non-clean streams), add billable non-model costs on top of
    // token-based model pricing.
    if (providerCostDollars !== undefined && providerCostDollars > 0) {
      actualCostPoints = billableCostDollarsToPoints(providerCostDollars);
    } else {
      const modelForActualCost = actualModelName ?? modelName;
      const actualInputCost = calculateTokenCost(
        actualInputTokens,
        "input",
        modelForActualCost,
      );
      const outputCost = calculateTokenCost(
        actualOutputTokens,
        "output",
        modelForActualCost,
      );
      const nonModelCostPoints =
        nonModelCostDollars > 0
          ? billableCostDollarsToPoints(nonModelCostDollars)
          : 0;
      actualCostPoints = actualInputCost + outputCost + nonModelCostPoints;
    }

    const initialCoveredPoints =
      initialDeduction !== undefined
        ? initialIncludedPoints + initialExtraUsagePoints
        : estimatedInputCost;

    // Calculate the difference between what has already been deducted and actual cost
    const costDifference = actualCostPoints - initialCoveredPoints;

    // If we over-estimated (pre-deducted more than actual), refund the difference
    if (costDifference < 0) {
      const pointsToRefund = Math.abs(costDifference);
      const extraUsageRefundTarget = Math.min(
        pointsToRefund,
        initialExtraUsagePoints,
      );

      if (extraUsageRefundTarget > 0) {
        const isTeamPool = subscription === "team" && !!organizationId;
        const refundResult = isTeamPool
          ? await refundToTeamBalance(
              organizationId!,
              userId,
              extraUsageRefundTarget,
            )
          : await refundToBalance(userId, extraUsageRefundTarget);

        if (!refundResult.success) {
          return lastKnownDeductionResult;
        }

        lastKnownDeductionResult = buildDeductionResult(
          0,
          0,
          0,
          extraUsageRefundTarget,
        );
      }

      const includedRefundPoints = Math.min(
        pointsToRefund - extraUsageRefundTarget,
        initialIncludedPoints,
      );
      if (includedRefundPoints > 0) {
        await refundBucketTokens(userId, subscription, includedRefundPoints);
        lastKnownDeductionResult = buildDeductionResult(
          0,
          0,
          includedRefundPoints,
          extraUsageRefundTarget,
        );
      }

      return lastKnownDeductionResult;
    }

    // If actual cost equals estimate, nothing more to do
    if (costDifference === 0)
      return withFinalCoverage(lastKnownDeductionResult);

    // Otherwise, we need to charge the additional cost.
    const deltaResult = await deductAdditionalUsagePoints({
      monthly,
      userId,
      subscription,
      additionalCostPoints: costDifference,
      extraUsageConfig,
      organizationId,
      usageSettlementId,
    });
    lastKnownDeductionResult = buildDeductionResult(
      deltaResult.includedPointsDeducted,
      deltaResult.extraUsagePointsDeducted,
    );
    return withFinalCoverage(
      lastKnownDeductionResult,
      deltaResult.usageDeductionFailureReason,
    );
  } catch (error) {
    console.error("Failed to deduct usage:", error);
    return withFinalCoverage(lastKnownDeductionResult, "deduction_failed");
  }
};

/**
 * Refund bucket tokens by adding capacity back to the monthly token bucket.
 * Uses direct Redis operations since Upstash Ratelimit doesn't have a native refund method.
 */
const refundBucketTokens = async (
  userId: string,
  subscription: SubscriptionTier,
  pointsToRefund: number,
): Promise<void> => {
  if (pointsToRefund <= 0) return;

  const redis = createRedisClient();
  if (!redis) return;

  const { monthly: monthlyLimit } = getBudgetLimits(subscription);
  const monthlyKey = getMonthlyBucketKey(userId, subscription);

  try {
    const monthlyTokens = await redis.hincrby(
      monthlyKey,
      "tokens",
      pointsToRefund,
    );

    const cycleAllocation = await getStoredCycleAllocation(
      redis,
      monthlyKey,
      monthlyLimit,
    );
    const refundCap = cycleAllocation ?? monthlyLimit;

    // Cap refunds at the current cycle allocation, which may be lower than
    // the broad subscription tier for grandfathered or prorated users.
    if (monthlyTokens > refundCap) {
      await redis.hset(monthlyKey, { tokens: refundCap });
    }
  } catch (error) {
    console.error("Failed to refund bucket tokens:", error);
  }
};

/**
 * Reset rate limit bucket for a user by deleting their Redis key.
 * On next request, Upstash Ratelimit creates a fresh bucket at full capacity.
 * Called when a subscription renews or changes tier.
 */
export const resetRateLimitBuckets = async (
  userId: string,
  subscription: SubscriptionTier,
  periodEndSeconds?: number,
  cycleAllocationPoints?: number,
): Promise<void> => {
  await initProratedBucket(
    userId,
    subscription,
    1.0,
    0,
    periodEndSeconds,
    cycleAllocationPoints,
  );
};

export type CycleAllocationCapResult = {
  created: boolean;
  previousAllocation: number;
  previousRemaining: number;
  targetAllocation: number;
  targetRemaining: number;
  pointsRemoved: number;
};

/**
 * Lower an existing cycle allocation without restoring already-consumed usage.
 * Used by one-time billing migrations; safe to rerun.
 */
export const capCurrentCycleAllocation = async (
  userId: string,
  subscription: SubscriptionTier,
  requestedAllocation: number,
  periodEndSeconds?: number,
): Promise<CycleAllocationCapResult> => {
  const redis = createRedisClient();
  if (!redis) throw new Error(RATE_LIMIT_SERVICE_NOT_CONFIGURED);

  const { monthly: tierMax } = getBudgetLimits(subscription);
  if (tierMax <= 0) {
    throw new Error(`Cannot set a cycle allocation for tier "${subscription}"`);
  }

  const requestedTargetAllocation = normalizeCycleAllocation(
    tierMax,
    requestedAllocation,
  );
  const monthlyKey = getMonthlyBucketKey(userId, subscription);
  const keyExists = Boolean(await redis.exists(monthlyKey));

  if (!keyExists) {
    await initProratedBucket(
      userId,
      subscription,
      1.0,
      0,
      periodEndSeconds,
      requestedTargetAllocation,
    );
    const createdAllocation = await getStoredCycleAllocation(
      redis,
      monthlyKey,
      tierMax,
    );
    if (createdAllocation !== requestedTargetAllocation) {
      throw new Error(
        `Failed to initialize the current cycle for user ${userId}`,
      );
    }
    await redis.expire(monthlyKey, getCycleExpireSeconds(periodEndSeconds));
    return {
      created: true,
      previousAllocation: tierMax,
      previousRemaining: tierMax,
      targetAllocation: requestedTargetAllocation,
      targetRemaining: requestedTargetAllocation,
      pointsRemoved: 0,
    };
  }

  const { monthly } = createRateLimiter(redis, userId, subscription);
  await monthly.limiter.limit(monthly.key, { rate: 0 });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const targetRefilledAt =
    periodEndSeconds &&
    Number.isFinite(periodEndSeconds) &&
    periodEndSeconds > nowSeconds
      ? (periodEndSeconds - THIRTY_DAYS_SECONDS) * 1000
      : -1;
  const [
    previousAllocation,
    previousRemaining,
    targetAllocation,
    targetRemaining,
    pointsRemoved,
  ] = await redis.eval<
    [number, number, number],
    [number, number, number, number, number]
  >(
    CAP_CYCLE_ALLOCATION_SCRIPT,
    [monthlyKey],
    [requestedTargetAllocation, tierMax, targetRefilledAt],
  );
  await redis.expire(
    monthlyKey,
    getCycleExpireSeconds(periodEndSeconds, nowSeconds),
  );

  return {
    created: false,
    previousAllocation,
    previousRemaining,
    targetAllocation,
    targetRemaining,
    pointsRemoved,
  };
};

/**
 * Delete Redis keys associated with a user across every rate-limit namespace
 * written by this codebase. Called during account deletion so orphaned
 * buckets, stashes, sliding-window counters, and seat-debt flags are purged
 * immediately rather than waiting on the 30-day TTL. Best-effort — returns
 * the number of keys deleted, never throws.
 *
 * Namespaces (keep in sync with key builders in this file and sliding-window.ts):
 *   - usage:monthly:<userId>:*       — monthly token bucket (any tier)
 *   - upgrade:carryover:<userId>:*   — tier-change stash, claim, and completion keys
 *   - free_limit:<userId>:*          — free-tier shared ask/agent sliding window
 *   - free_referral_bonus:<userId>   — one-time free request units from referral signup
 *   - free_referral_bonus_grant:*:<userId> — referral bonus grant idempotency marker
 *   - free_agent_limit:<userId>:*    — legacy free-tier agent sliding window
 *   - free_monthly_cost:<userId>:*   — free-tier monthly provider/tool cost cap
 *   - free_run_lock:<userId>         — free-tier active-run concurrency lock
 *   - team:debt_applied:*:<userId>   — seat-debt idempotency flag (org-scoped)
 *
 * Deliberately NOT included: team:removed_usage:<orgId> (org counter, not
 * user-scoped) and any extra-usage balance records (stored in Convex, not Redis).
 */
export const deleteUserRateLimitKeys = async (
  userId: string,
): Promise<number> => {
  const redis = createRedisClient();
  if (!redis) return 0;

  try {
    const keys = Array.from(
      new Set(
        (await scanRedisKeys(redis, `*${userId}*`)).filter((key) =>
          isUserRateLimitKey(key, userId),
        ),
      ),
    );
    if (keys.length === 0) return 0;
    await deleteRedisKeys(redis, keys);
    return keys.length;
  } catch (error) {
    console.error(
      `[deleteUserRateLimitKeys] Failed for user ${userId}:`,
      error,
    );
    return 0;
  }
};

// =============================================================================
// Tier-change proration
// =============================================================================

const TIER_CHANGE_STASH_TTL_SECONDS = 24 * 60 * 60;
const TIER_CHANGE_COMPLETED_TTL_SECONDS = 35 * 24 * 60 * 60;
const THIRTY_DAYS_MS = THIRTY_DAYS_SECONDS * 1000;

export type TierChangeIdentity = {
  subscriptionId: string;
  targetTier: SubscriptionTier;
  transitionId: string;
};

const tierChangeStashKey = (userId: string, transitionId: string) =>
  `upgrade:carryover:${userId}:${transitionId}`;
const tierChangeClaimKey = (stashKey: string) => `${stashKey}:claim`;
const tierChangeCompletedKey = (stashKey: string) => `${stashKey}:completed`;

export type TierChangeBucketState = {
  version: 3;
  oldTier: SubscriptionTier | null;
  targetTier: SubscriptionTier | null;
  subscriptionId: string | null;
  transitionId: string | null;
  remaining: number;
  cycleAllocation: number;
  resetAtMs: number;
};

export type TierChangeCredits = {
  consumedCredits: number;
  incrementalCredits: number;
  cycleAllocation: number;
  remainingCredits: number;
};

export type AppliedTierChangeBucket = TierChangeCredits & {
  proratedRatio: number;
  resetAtMs: number;
};

const parseTierChangeBucketState = (
  raw: string | Record<string, unknown>,
): TierChangeBucketState => {
  const parsed =
    typeof raw === "string"
      ? (JSON.parse(raw) as Record<string, unknown>)
      : raw;
  const remaining = finiteNonNegativePoints(parsed.remaining) ?? 0;
  const legacyConsumed = finiteNonNegativePoints(parsed.consumed) ?? 0;
  const cycleAllocation =
    finiteNonNegativePoints(parsed.cycleAllocation) ??
    remaining + legacyConsumed;
  const resetAtMs = finiteNonNegativePoints(parsed.resetAtMs) ?? 0;
  const oldTier =
    typeof parsed.oldTier === "string" && parsed.oldTier in MONTHLY_CREDITS
      ? (parsed.oldTier as SubscriptionTier)
      : null;
  const targetTier =
    typeof parsed.targetTier === "string" &&
    parsed.targetTier in MONTHLY_CREDITS
      ? (parsed.targetTier as SubscriptionTier)
      : null;
  const subscriptionId =
    typeof parsed.subscriptionId === "string" && parsed.subscriptionId
      ? parsed.subscriptionId
      : null;
  const transitionId =
    typeof parsed.transitionId === "string" && parsed.transitionId
      ? parsed.transitionId
      : null;

  return {
    version: 3,
    oldTier,
    targetTier,
    subscriptionId,
    transitionId,
    remaining: Math.min(remaining, cycleAllocation),
    cycleAllocation,
    resetAtMs,
  };
};

const STASH_TIER_CHANGE_BUCKET_SCRIPT = `
local bucketKey = KEYS[1]
local stashKey = KEYS[2]
local completedKey = KEYS[3]
local oldCycleMax = tonumber(ARGV[1])
local resetAtMs = tonumber(ARGV[2])
local oldTier = ARGV[3]
local ttlSeconds = tonumber(ARGV[4])
local subscriptionId = ARGV[5]
local targetTier = ARGV[6]
local transitionId = ARGV[7]

if redis.call("EXISTS", completedKey) == 1 then
  redis.call("DEL", bucketKey)
  return nil
end

local existing = redis.call("GET", stashKey)
if existing then
  redis.call("DEL", bucketKey)
  return existing
end

local tokens = tonumber(redis.call("HGET", bucketKey, "tokens")) or oldCycleMax
local allocation = tonumber(redis.call("HGET", bucketKey, "cycleAllocation")) or oldCycleMax
allocation = math.max(0, math.min(oldCycleMax, allocation))
local remaining = math.max(0, math.min(allocation, tokens))
local state = cjson.encode({
  version = 3,
  oldTier = oldTier,
  targetTier = targetTier,
  subscriptionId = subscriptionId,
  transitionId = transitionId,
  remaining = remaining,
  cycleAllocation = allocation,
  resetAtMs = resetAtMs
})

redis.call("SET", stashKey, state, "EX", ttlSeconds)
redis.call("DEL", bucketKey)
return state
`;

const CLAIM_TIER_CHANGE_BUCKET_SCRIPT = `
local stashKey = KEYS[1]
local claimKey = KEYS[2]
local completedKey = KEYS[3]
local ttlSeconds = tonumber(ARGV[1])

if redis.call("EXISTS", completedKey) == 1 then
  return nil
end

local raw = redis.call("GET", claimKey)
if raw then return raw end

raw = redis.call("GET", stashKey)
if not raw then return nil end

redis.call("SET", claimKey, raw, "EX", ttlSeconds)
return raw
`;

const SET_MONTHLY_BUCKET_STATE_SCRIPT = `
local bucketKey = KEYS[1]
local remaining = tonumber(ARGV[1])
local allocation = tonumber(ARGV[2])
local tierMax = tonumber(ARGV[3])
local cycleStartedAt = tonumber(ARGV[4])
local refilledAt = tonumber(ARGV[5])
local expireSeconds = tonumber(ARGV[6])

redis.call("DEL", bucketKey)
redis.call(
  "HSET",
  bucketKey,
  "tokens", remaining,
  "cycleAllocation", allocation,
  "cycleTierMax", tierMax,
  "cycleStartedAt", cycleStartedAt,
  "refilledAt", refilledAt
)
redis.call("EXPIRE", bucketKey, expireSeconds)
return remaining
`;

const APPLY_TIER_CHANGE_BUCKET_SCRIPT = `
local bucketKey = KEYS[1]
local stashKey = KEYS[2]
local claimKey = KEYS[3]
local completedKey = KEYS[4]
local expectedClaim = ARGV[1]
local desiredRemaining = tonumber(ARGV[2])
local allocation = tonumber(ARGV[3])
local tierMax = tonumber(ARGV[4])
local cycleStartedAt = tonumber(ARGV[5])
local refilledAt = tonumber(ARGV[6])
local expireSeconds = tonumber(ARGV[7])
local completedTtlSeconds = tonumber(ARGV[8])

if redis.call("GET", claimKey) ~= expectedClaim then
  return {0, 0}
end
if redis.call("GET", stashKey) ~= expectedClaim then
  return {0, 0}
end

-- A request can create the target-tier bucket in the short interval between
-- Stripe changing the entitlement and this migration. Preserve that usage.
local existingTokens = tonumber(redis.call("HGET", bucketKey, "tokens"))
local existingAllocation = redis.call("HGET", bucketKey, "cycleAllocation")
local remaining = desiredRemaining
if existingTokens and not existingAllocation then
  local provisionalConsumed = math.max(0, tierMax - existingTokens)
  remaining = math.max(0, desiredRemaining - provisionalConsumed)
end

redis.call("DEL", bucketKey)
redis.call(
  "HSET",
  bucketKey,
  "tokens", remaining,
  "cycleAllocation", allocation,
  "cycleTierMax", tierMax,
  "cycleStartedAt", cycleStartedAt,
  "refilledAt", refilledAt
)
redis.call("EXPIRE", bucketKey, expireSeconds)
redis.call("SET", completedKey, "1", "EX", completedTtlSeconds)
redis.call("DEL", stashKey, claimKey)
return {1, remaining}
`;

/**
 * Atomically preserve the authoritative old-cycle allocation and remaining
 * credits, then remove the old-tier bucket. Throws on storage failures so
 * Stripe retries the event instead of accepting a partially applied change.
 */
export const stashTierChangeBucketState = async (
  userId: string,
  oldTier: SubscriptionTier,
  options: {
    identity: TierChangeIdentity;
    oldCycleAllocationPoints?: number;
  },
): Promise<TierChangeBucketState | null> => {
  const redis = createRedisClient();
  if (!redis) throw new Error(RATE_LIMIT_SERVICE_NOT_CONFIGURED);

  const oldTierMax = MONTHLY_CREDITS[oldTier] ?? 0;
  if (oldTierMax <= 0) {
    throw new Error(`Cannot migrate a bucket from tier "${oldTier}"`);
  }
  const oldCycleMax = normalizeCycleAllocation(
    oldTierMax,
    options.oldCycleAllocationPoints,
  );

  const { monthly } = createRateLimiter(redis, userId, oldTier);
  const snapshot = await monthly.limiter.limit(monthly.key, { rate: 0 });
  const resetAtMs =
    Number.isFinite(snapshot.reset) && snapshot.reset > Date.now()
      ? snapshot.reset
      : Date.now() + THIRTY_DAYS_MS;
  const stashKey = tierChangeStashKey(userId, options.identity.transitionId);
  const raw = await redis.eval<
    [number, number, string, number, string, string, string],
    string | null
  >(
    STASH_TIER_CHANGE_BUCKET_SCRIPT,
    [
      getMonthlyBucketKey(userId, oldTier),
      stashKey,
      tierChangeCompletedKey(stashKey),
    ],
    [
      oldCycleMax,
      resetAtMs,
      oldTier,
      TIER_CHANGE_STASH_TTL_SECONDS,
      options.identity.subscriptionId,
      options.identity.targetTier,
      options.identity.transitionId,
    ],
  );

  return raw ? parseTierChangeBucketState(raw) : null;
};

/**
 * Compute the new cycle from the old cycle, not from the whole new plan.
 * Upgrades add only the prorated difference between allocations. Downgrades
 * cap the cycle immediately without restoring already-consumed credits.
 */
export const calculateTierChangeCredits = (
  newCycleMax: number,
  oldCycleAllocation: number,
  oldRemaining: number,
  proratedRatio: number,
): TierChangeCredits => {
  const normalizedNewMax = Math.max(0, Math.round(newCycleMax));
  const normalizedOldAllocation = Math.max(0, Math.round(oldCycleAllocation));
  const normalizedOldRemaining = Math.min(
    normalizedOldAllocation,
    Math.max(0, Math.round(oldRemaining)),
  );
  const normalizedRatio = Number.isFinite(proratedRatio)
    ? Math.max(0, Math.min(1, proratedRatio))
    : 0;
  const consumedCredits = Math.max(
    0,
    normalizedOldAllocation - normalizedOldRemaining,
  );
  const isUpgrade = normalizedNewMax >= normalizedOldAllocation;
  const incrementalCredits = isUpgrade
    ? Math.floor((normalizedNewMax - normalizedOldAllocation) * normalizedRatio)
    : 0;
  const cycleAllocation = isUpgrade
    ? normalizedOldAllocation + incrementalCredits
    : normalizedNewMax;

  return {
    consumedCredits,
    incrementalCredits,
    cycleAllocation,
    remainingCredits: Math.max(0, cycleAllocation - consumedCredits),
  };
};

const writeMonthlyBucketState = async (
  redis: RedisClient,
  userId: string,
  tier: SubscriptionTier,
  cycleAllocation: number,
  remainingCredits: number,
  periodEndSeconds?: number,
): Promise<void> => {
  const tierMax = MONTHLY_CREDITS[tier] ?? 0;
  if (tierMax <= 0) {
    throw new Error(`Cannot initialize a bucket for tier "${tier}"`);
  }

  const normalizedAllocation = normalizeCycleAllocation(
    tierMax,
    cycleAllocation,
  );
  const normalizedRemaining = Math.min(
    normalizedAllocation,
    Math.max(0, Math.round(remainingCredits)),
  );
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const refilledAt =
    periodEndSeconds &&
    Number.isFinite(periodEndSeconds) &&
    periodEndSeconds > nowSeconds
      ? (periodEndSeconds - THIRTY_DAYS_SECONDS) * 1000
      : nowMs;
  await redis.eval<[number, number, number, number, number, number], number>(
    SET_MONTHLY_BUCKET_STATE_SCRIPT,
    [getMonthlyBucketKey(userId, tier)],
    [
      normalizedRemaining,
      normalizedAllocation,
      tierMax,
      nowMs,
      refilledAt,
      getCycleExpireSeconds(periodEndSeconds, nowSeconds),
    ],
  );
};

/**
 * Claim and apply one stashed tier change. Missing state is a safe no-op: an
 * unrelated subscription-update invoice must never mint a fresh bucket.
 */
export const applyProratedTierChangeBucket = async (
  userId: string,
  newTier: SubscriptionTier,
  options: {
    identity: TierChangeIdentity;
    proratedRatio?: number;
    periodEndSeconds?: number;
    cycleAllocationPoints?: number;
  },
): Promise<AppliedTierChangeBucket | null> => {
  const redis = createRedisClient();
  if (!redis) throw new Error(RATE_LIMIT_SERVICE_NOT_CONFIGURED);

  const stashKey = tierChangeStashKey(userId, options.identity.transitionId);
  const claimKey = tierChangeClaimKey(stashKey);
  const completedKey = tierChangeCompletedKey(stashKey);
  const raw = await redis.eval<[number], string | null>(
    CLAIM_TIER_CHANGE_BUCKET_SCRIPT,
    [stashKey, claimKey, completedKey],
    [TIER_CHANGE_STASH_TTL_SECONDS],
  );
  if (!raw) return null;

  const state = parseTierChangeBucketState(raw);
  if (
    state.subscriptionId !== options.identity.subscriptionId ||
    state.targetTier !== newTier ||
    state.transitionId !== options.identity.transitionId
  ) {
    return null;
  }
  const nowMs = Date.now();
  const fallbackResetAtMs =
    options.periodEndSeconds && Number.isFinite(options.periodEndSeconds)
      ? options.periodEndSeconds * 1000
      : 0;
  const storedResetAtMs = state.resetAtMs || fallbackResetAtMs;
  // Never let a delayed proration webhook overwrite a newer renewal bucket.
  if (state.resetAtMs > 0 && state.resetAtMs <= nowMs) return null;

  const tierMax = MONTHLY_CREDITS[newTier] ?? 0;
  const newCycleMax = normalizeCycleAllocation(
    tierMax,
    options.cycleAllocationPoints,
  );
  const derivedRatio = Math.max(
    0,
    Math.min(1, (state.resetAtMs - nowMs) / THIRTY_DAYS_MS),
  );
  const proratedRatio =
    options.proratedRatio !== undefined
      ? Math.max(0, Math.min(1, options.proratedRatio))
      : derivedRatio;
  const credits = calculateTierChangeCredits(
    newCycleMax,
    state.cycleAllocation,
    state.remaining,
    proratedRatio,
  );
  const periodEndSeconds =
    storedResetAtMs > nowMs ? Math.ceil(storedResetAtMs / 1000) : undefined;
  const refilledAt = periodEndSeconds
    ? (periodEndSeconds - THIRTY_DAYS_SECONDS) * 1000
    : nowMs;
  const [applied, appliedRemaining] = await redis.eval<
    [string, number, number, number, number, number, number, number],
    [number, number]
  >(
    APPLY_TIER_CHANGE_BUCKET_SCRIPT,
    [getMonthlyBucketKey(userId, newTier), stashKey, claimKey, completedKey],
    [
      raw,
      credits.remainingCredits,
      credits.cycleAllocation,
      tierMax,
      nowMs,
      refilledAt,
      getCycleExpireSeconds(periodEndSeconds, Math.floor(nowMs / 1000)),
      TIER_CHANGE_COMPLETED_TTL_SECONDS,
    ],
  );
  if (applied !== 1) return null;

  return {
    ...credits,
    remainingCredits: appliedRemaining,
    proratedRatio,
    resetAtMs: storedResetAtMs,
  };
};

/**
 * Initialize a prorated token bucket for a mid-cycle upgrade.
 * Works by creating a full-capacity bucket then "burning" the excess.
 *
 * @param consumedCredits - Credits already consumed from the old tier this cycle.
 *   Deducted from the prorated allocation so users can't "double-dip".
 * @param periodEndSeconds - Optional Stripe `current_period_end` (unix seconds).
 *   When supplied, the bucket's internal `refilledAt` is rewritten so Upstash's
 *   reported reset (`refilledAt + 30 d`) lands on the actual invoice date
 *   instead of 30 days from now. Matters for mid-cycle upgrades, where the
 *   remaining cycle is shorter than 30 days.
 */
export const initProratedBucket = async (
  userId: string,
  newTier: SubscriptionTier,
  proratedRatio: number,
  consumedCredits: number = 0,
  periodEndSeconds?: number,
  cycleAllocationPoints?: number,
): Promise<void> => {
  const redis = createRedisClient();
  if (!redis) return;

  const newTierMax = MONTHLY_CREDITS[newTier] ?? 0;
  if (newTierMax === 0) return;

  const cycleMax = normalizeCycleAllocation(newTierMax, cycleAllocationPoints);
  const normalizedRatio = Number.isFinite(proratedRatio)
    ? Math.max(0, Math.min(1, proratedRatio))
    : 0;
  const cycleAllocation = Math.floor(cycleMax * normalizedRatio);
  const totalCredits = Math.max(
    0,
    cycleAllocation - Math.max(0, Math.round(consumedCredits)),
  );

  try {
    await writeMonthlyBucketState(
      redis,
      userId,
      newTier,
      cycleAllocation,
      totalCredits,
      periodEndSeconds,
    );
  } catch (error) {
    console.error(`[initProratedBucket] Failed for user ${userId}:`, error);
  }
};

// =============================================================================
// Team Seat Rotation Protection
// =============================================================================

const TEAM_CREDITS = MONTHLY_CREDITS["team"] ?? 0;

/** Redis key for accumulated removed-member usage per org. */
const orgRemovedUsageKey = (orgId: string) => `team:removed_usage:${orgId}`;

/** Redis key to ensure seat debt is applied only once per user per cycle. */
const debtAppliedKey = (orgId: string, userId: string) =>
  `team:debt_applied:${orgId}:${userId}`;

/**
 * Get how many points a team member has consumed from their bucket.
 * Returns 0 if no bucket exists.
 */
export const getTeamMemberConsumed = async (
  userId: string,
): Promise<number> => {
  const redis = createRedisClient();
  if (!redis) return 0;

  try {
    const tokens = await redis.hget<number>(
      getMonthlyBucketKey(userId, "team"),
      "tokens",
    );
    return Math.max(0, TEAM_CREDITS - (tokens ?? TEAM_CREDITS));
  } catch (error) {
    console.error(`[getTeamMemberConsumed] Failed for user ${userId}:`, error);
    return 0;
  }
};

/**
 * Add a removed member's consumed credits to the org-level counter.
 * Called when a team member is removed so the next new member inherits the debt.
 */
export const addOrgRemovedUsage = async (
  orgId: string,
  points: number,
): Promise<void> => {
  if (points <= 0) return;

  const redis = createRedisClient();
  if (!redis) return;

  const key = orgRemovedUsageKey(orgId);

  try {
    await redis.incrby(key, points);
    // Ensure TTL is set (idempotent — only sets if no TTL exists)
    const ttl = await redis.ttl(key);
    if (ttl < 0) {
      await redis.expire(key, THIRTY_DAYS_SECONDS);
    }
  } catch (error) {
    console.error(`[addOrgRemovedUsage] Failed for org ${orgId}:`, error);
  }
};

/**
 * Clear the org-level removed-member usage counter.
 * Called on subscription renewal to start a fresh cycle.
 */
export const clearOrgRemovedUsage = async (orgId: string): Promise<void> => {
  const redis = createRedisClient();
  if (!redis) return;

  try {
    await redis.del(orgRemovedUsageKey(orgId));
  } catch (error) {
    console.error(`[clearOrgRemovedUsage] Failed for org ${orgId}:`, error);
  }
};

/**
 * Apply seat debt to a new team member's bucket on first use.
 * Burns up to one seat's worth (400k points) from their bucket, debiting the
 * org counter by the same amount. Uses a flag key to ensure idempotency.
 */
export const applyTeamSeatDebt = async (
  userId: string,
  orgId: string,
): Promise<void> => {
  const redis = createRedisClient();
  if (!redis) return;

  const flagKey = debtAppliedKey(orgId, userId);

  try {
    // Atomically claim the flag — if SET NX returns null, another request already claimed it
    const claimed = await redis.set(flagKey, 1, {
      ex: THIRTY_DAYS_SECONDS,
      nx: true,
    });
    if (!claimed) return;

    // Atomically claim up to one seat's worth of debt.
    // decrby is atomic, so concurrent new members can't claim the same debt.
    const key = orgRemovedUsageKey(orgId);
    const afterDecr = await redis.decrby(key, TEAM_CREDITS);
    // afterDecr = oldDebt - TEAM_CREDITS
    // If afterDecr >= 0: we claimed a full TEAM_CREDITS of debt
    // If afterDecr < 0: debt was less than TEAM_CREDITS, refund the excess
    // If afterDecr <= -TEAM_CREDITS: there was no debt at all
    const overclaim = Math.max(0, -afterDecr);
    const debit = TEAM_CREDITS - overclaim;

    if (debit <= 0) {
      // No debt existed — restore counter and skip
      await redis.incrby(key, TEAM_CREDITS);
      return;
    }

    // Restore any excess we claimed beyond actual debt
    if (overclaim > 0) {
      await redis.incrby(key, overclaim);
    }

    // Burn the claimed debt from the user's bucket
    try {
      const { monthly } = createRateLimiter(redis, userId, "team");
      await monthly.limiter.limit(monthly.key, { rate: debit });
    } catch (burnError) {
      // Bucket burn failed — restore the debt we claimed so it's not lost
      await redis.incrby(key, debit);
      // Clear the flag so a retry can re-attempt
      await redis.del(flagKey);
      throw burnError;
    }
  } catch (error) {
    console.error(`[applyTeamSeatDebt] Failed for user ${userId}:`, error);
  }
};

// =============================================================================
// Refund
// =============================================================================

/**
 * Refund usage when a request fails after credits were deducted.
 * Refunds both token bucket credits and extra usage balance.
 */
export const refundUsage = async (
  userId: string,
  subscription: SubscriptionTier,
  pointsDeducted: number,
  extraUsagePointsDeducted: number,
  organizationId?: string,
): Promise<void> => {
  const refundPromises: Promise<void>[] = [];

  if (pointsDeducted > 0) {
    refundPromises.push(
      refundBucketTokens(userId, subscription, pointsDeducted),
    );
  }

  if (extraUsagePointsDeducted > 0) {
    const isTeamPool = subscription === "team" && !!organizationId;
    refundPromises.push(
      isTeamPool
        ? refundToTeamBalance(
            organizationId!,
            userId,
            extraUsagePointsDeducted,
          ).then(() => {})
        : refundToBalance(userId, extraUsagePointsDeducted).then(() => {}),
    );
  }

  if (refundPromises.length > 0) {
    try {
      await Promise.all(refundPromises);
    } catch (error) {
      console.error("Failed to refund usage:", error);
    }
  }
};
