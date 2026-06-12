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

/** Model pricing: $/1M tokens per model (default used for ask models + gemini 3 flash agent) */
const MODEL_PRICING_MAP: Record<string, { input: number; output: number }> = {
  default: { input: 0.5, output: 3.0 },
  "model-sonnet-4.6": { input: 3.0, output: 15.0 },
  "model-gemini-3-flash": { input: 0.5, output: 3.0 },
  "fallback-gemini-3.5-flash": { input: 1.5, output: 9.0 },
  "model-opus-4.6": { input: 5.0, output: 25.0 },
  // "agent-model" and "model-kimi-k2.7-code" route to
  // moonshotai/kimi-k2.7-code via lib/ai/providers.ts. Rates from OpenRouter:
  // $0.95 in / $4.00 out per 1M tokens. The old model-kimi-k2.6 key remains
  // priced here as a compatibility alias. Cache-read discount ($0.16/M) applies
  // when provider cost is available via usage.raw.cost.
  "agent-model": { input: 0.95, output: 4.0 },
  "agent-model-free": { input: 0.95, output: 4.0 },
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
export const NORMAL_USAGE_MULTIPLIER = 1.3;

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

    // Helper to build RateLimitInfo from a limiter result
    const buildResult = (
      result: { remaining: number; reset: number },
      pointsDeducted: number,
      extraUsagePointsDeducted?: number,
    ): RateLimitInfo => ({
      remaining: result.remaining,
      resetTime: new Date(result.reset),
      limit: monthlyLimit,
      monthly: {
        remaining: result.remaining,
        limit: monthlyLimit,
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
 * Deduct additional cost after processing (output + any input difference).
 * If extra usage was used for input (bucket at 0), also deducts output from extra usage.
 * If we over-estimated input cost, refunds the difference back to the bucket.
 *
 * @param providerCostDollars - If provided (from usage.raw.cost), uses this instead of token calculation.
 *   On clean completions this includes model + sandbox + tool costs.
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
): Promise<void> => {
  const redis = createRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV !== "production") return;
    throwRateLimitServiceNotConfigured();
  }

  try {
    const { monthly, monthlyLimit } = createRateLimiter(
      redis,
      userId,
      subscription,
    );
    if (monthlyLimit === 0) return;

    // Calculate estimated input cost (already deducted upfront)
    const estimatedInputCost = calculateTokenCost(
      estimatedInputTokens,
      "input",
      modelName,
    );

    // Calculate actual cost - prefer provider cost if available.
    // Provider cost already includes non-model costs (sandbox/tools) when present.
    // When absent (non-clean streams), add non-model costs on top of token-based estimate.
    let actualCostPoints: number;

    if (providerCostDollars !== undefined && providerCostDollars > 0) {
      actualCostPoints = Math.ceil(providerCostDollars * POINTS_PER_DOLLAR);
    } else {
      const actualInputCost = calculateTokenCost(
        actualInputTokens,
        "input",
        modelName,
      );
      const outputCost = calculateTokenCost(
        actualOutputTokens,
        "output",
        modelName,
      );
      const nonModelCostPoints =
        nonModelCostDollars > 0
          ? Math.ceil(nonModelCostDollars * POINTS_PER_DOLLAR)
          : 0;
      actualCostPoints = actualInputCost + outputCost + nonModelCostPoints;
    }

    // Calculate the difference between what we pre-deducted and actual cost
    const costDifference = actualCostPoints - estimatedInputCost;

    // If we over-estimated (pre-deducted more than actual), refund the difference
    if (costDifference < 0) {
      await refundBucketTokens(userId, subscription, Math.abs(costDifference));
      return;
    }

    // If actual cost equals estimate, nothing more to do
    if (costDifference === 0) return;

    // Otherwise, we need to charge the additional cost.
    // First, peek at remaining balance to avoid going negative.
    const additionalCost = costDifference;
    const peekResult = await monthly.limiter.limit(monthly.key, { rate: 0 });
    const available = Math.max(0, peekResult.remaining);

    const fromBucket = Math.min(additionalCost, available);
    const fromExtraUsage = additionalCost - fromBucket;

    // Deduct only what the bucket can cover
    if (fromBucket > 0) {
      await monthly.limiter.limit(monthly.key, { rate: fromBucket });
    }

    // Send overflow to extra usage if enabled
    if (
      fromExtraUsage > 0 &&
      extraUsageConfig?.enabled &&
      (extraUsageConfig.hasBalance || extraUsageConfig.autoReloadEnabled)
    ) {
      const isTeamPool = subscription === "team" && !!organizationId;
      if (isTeamPool) {
        await deductFromTeamBalance(organizationId!, userId, fromExtraUsage);
      } else {
        await deductFromBalance(userId, fromExtraUsage);
      }
    }
  } catch (error) {
    console.error("Failed to deduct usage:", error);
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

    // Cap at limit if we exceeded it (edge case)
    if (monthlyTokens > monthlyLimit) {
      await redis.hset(monthlyKey, { tokens: monthlyLimit });
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
): Promise<void> => {
  await initProratedBucket(userId, subscription, 1.0, 0, periodEndSeconds);
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
 *   - upgrade:carryover:<userId>     — upgrade proration stash
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
// Upgrade Proration
// =============================================================================

/**
 * Stash the old bucket's remaining tokens in a temporary Redis key before
 * deleting the bucket on tier change. The `invoice.paid` handler picks this
 * up to carry over unused credits into the prorated new-tier bucket.
 */
export const stashOldBucketRemaining = async (
  userId: string,
  oldTier: SubscriptionTier,
): Promise<void> => {
  const redis = createRedisClient();
  if (!redis) return;

  const monthlyKey = getMonthlyBucketKey(userId, oldTier);
  const stashKey = `upgrade:carryover:${userId}`;
  const oldTierMax = MONTHLY_CREDITS[oldTier] ?? 0;

  try {
    const tokens = await redis.hget<number>(monthlyKey, "tokens");
    const remaining = Math.max(0, tokens ?? 0);
    const consumed = Math.max(0, oldTierMax - remaining);
    // Stash both remaining and consumed so proration can deduct old-tier usage
    await redis.set(stashKey, JSON.stringify({ remaining, consumed }), {
      ex: 300,
    }); // 5-minute TTL
  } catch (error) {
    console.error(
      `[stashOldBucketRemaining] Failed for user ${userId}:`,
      error,
    );
  }
};

/**
 * Pop the stashed carry-over data for a user. Returns remaining and consumed
 * credits from the old tier, or null if no stash exists (no tier change
 * happened). The null case is used by the webhook to distinguish real tier
 * changes from other subscription updates (e.g. quantity changes).
 */
export const popOldBucketRemaining = async (
  userId: string,
): Promise<{ remaining: number; consumed: number } | null> => {
  const redis = createRedisClient();
  if (!redis) return null;

  const stashKey = `upgrade:carryover:${userId}`;

  try {
    const raw = await redis.get<string>(stashKey);
    if (raw !== null) {
      await redis.del(stashKey);
    }
    if (!raw) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {
      remaining: Math.max(0, parsed.remaining ?? 0),
      consumed: Math.max(0, parsed.consumed ?? 0),
    };
  } catch (error) {
    console.error(`[popOldBucketRemaining] Failed for user ${userId}:`, error);
    return null;
  }
};

/**
 * Calculate prorated credits for a mid-cycle upgrade (pure function).
 *
 *   proratedCredits = floor(tierMax * proratedRatio) - consumed
 *   totalCredits    = max(0, proratedCredits)
 *
 * Subtracting consumed ensures a user who burns all old-tier credits
 * then upgrades doesn't get a near-full new-tier bucket for the same cycle.
 */
export const calculateProratedCredits = (
  tierMax: number,
  proratedRatio: number,
  consumedCredits: number = 0,
): { proratedCredits: number; totalCredits: number; burnAmount: number } => {
  const rawProrated = Math.floor(tierMax * proratedRatio);
  const consumed = Math.max(0, consumedCredits);
  const totalCredits = Math.max(0, Math.min(rawProrated - consumed, tierMax));
  return {
    proratedCredits: rawProrated,
    totalCredits,
    burnAmount: tierMax - totalCredits,
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
): Promise<void> => {
  const redis = createRedisClient();
  if (!redis) return;

  const newTierMax = MONTHLY_CREDITS[newTier] ?? 0;
  if (newTierMax === 0) return;

  const { burnAmount, totalCredits } = calculateProratedCredits(
    newTierMax,
    proratedRatio,
    consumedCredits,
  );
  const monthlyKey = getMonthlyBucketKey(userId, newTier);

  try {
    // Delete any existing bucket for the new tier
    await redis.del(monthlyKey);

    // Create fresh bucket at full capacity
    const { monthly } = createRateLimiter(redis, userId, newTier);
    await monthly.limiter.limit(monthly.key, { rate: 0 });

    // Burn excess to bring bucket down to prorated level
    if (burnAmount > 0) {
      await monthly.limiter.limit(monthly.key, { rate: burnAmount });
    }

    // Align the UI-facing reset time with Stripe's billing cycle. Upstash's
    // token bucket computes reset as `refilledAt + interval`; our interval is
    // hardcoded to 30 d, so setting `refilledAt = periodEnd - 30 d` makes the
    // reported reset land exactly on the next invoice date. `refilledAt` is
    // an internal field of @upstash/ratelimit — re-verify on SDK upgrades.
    const bucketMetadata: Record<string, number> = {
      cycleAllocation: totalCredits,
      cycleTierMax: newTierMax,
      cycleStartedAt: Date.now(),
    };
    const nowSeconds = Math.floor(bucketMetadata.cycleStartedAt / 1000);

    if (
      periodEndSeconds &&
      Number.isFinite(periodEndSeconds) &&
      periodEndSeconds > nowSeconds
    ) {
      const targetRefilledAtMs =
        (periodEndSeconds - THIRTY_DAYS_SECONDS) * 1000;
      bucketMetadata.refilledAt = targetRefilledAtMs;
    }

    await redis.hset(monthlyKey, bucketMetadata);
    await redis.expire(
      monthlyKey,
      getCycleExpireSeconds(periodEndSeconds, nowSeconds),
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
