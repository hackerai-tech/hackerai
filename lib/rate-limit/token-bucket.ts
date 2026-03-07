import { Ratelimit } from "@upstash/ratelimit";
import { ChatSDKError } from "@/lib/errors";
import type {
  SubscriptionTier,
  RateLimitInfo,
  ExtraUsageConfig,
} from "@/types";
import { createRedisClient, formatTimeRemaining } from "./redis";
import { PRICING } from "@/lib/pricing/features";
import { deductFromBalance, refundToBalance } from "@/lib/extra-usage";

// =============================================================================
// Configuration
// =============================================================================

/** Model pricing: $/1M tokens per model (default used for ask models + kimi k2.5 agent) */
const MODEL_PRICING_MAP: Record<string, { input: number; output: number }> = {
  default: { input: 0.5, output: 3.0 },
  "model-sonnet-4.6": { input: 3.0, output: 15.0 },
  "model-gemini-3.1-pro": { input: 2.0, output: 12.0 },
  "model-grok-4.1": { input: 0.2, output: 0.5 },
  "model-gemini-3-flash": { input: 0.5, output: 3.0 },
  "model-kimi-k2.5": { input: 0.6, output: 3.0 },
  "model-gpt-5.4": { input: 2.5, output: 15.0 },
};

const getModelPricing = (modelName?: string) =>
  (modelName && MODEL_PRICING_MAP[modelName]) || MODEL_PRICING_MAP.default;

/** Microdollars per dollar — used only for Redis integer operations */
const MICRODOLLARS_PER_DOLLAR = 1_000_000;

/** Convert dollars to microdollars for Redis operations */
const dollarsToMicro = (dollars: number): number =>
  Math.ceil(dollars * MICRODOLLARS_PER_DOLLAR);

/** Convert microdollars back to dollars */
const microToDollars = (micro: number): number =>
  micro / MICRODOLLARS_PER_DOLLAR;

// =============================================================================
// Cost Calculation
// =============================================================================

/**
 * Calculate dollar cost for tokens.
 * @param tokens - Number of tokens
 * @param type - "input" or "output"
 * @param modelName - Optional model name for model-specific pricing
 * @returns Cost in dollars
 */
export const calculateTokenCost = (
  tokens: number,
  type: "input" | "output",
  modelName?: string,
): number => {
  if (tokens <= 0) return 0;
  const pricing = getModelPricing(modelName);
  const price = type === "input" ? pricing.input : pricing.output;
  return (tokens / 1_000_000) * price;
};

// =============================================================================
// Budget Limits
// =============================================================================

/**
 * Get monthly budget limit for a subscription tier.
 * @returns Monthly budget in dollars
 */
export const getBudgetLimit = (subscription: SubscriptionTier): number => {
  if (subscription === "free") return 0;
  return PRICING[subscription]?.monthly ?? 0;
};

/** @deprecated Use getBudgetLimit instead. Kept for backward compat during migration. */
export const getBudgetLimits = (
  subscription: SubscriptionTier,
): { session: number; weekly: number } => {
  const monthly = getBudgetLimit(subscription);
  return { session: monthly / 30, weekly: (monthly * 7) / 30 };
};

/** Get monthly budget (full subscription price, shared between modes) */
export const getSubscriptionPrice = (
  subscription: SubscriptionTier,
): number => {
  if (subscription === "free") return 0;
  return PRICING[subscription]?.monthly ?? 0;
};

// =============================================================================
// Rate Limiting — Single Monthly Bucket
// =============================================================================

/**
 * Create the monthly rate limiter for a user.
 * Budget is the full monthly subscription price, refills every 30 days.
 */
const createRateLimiter = (
  redis: ReturnType<typeof createRedisClient>,
  userId: string,
  subscription: SubscriptionTier,
) => {
  const monthlyLimit = getBudgetLimit(subscription);
  const monthlyMicro = dollarsToMicro(monthlyLimit);

  return {
    monthlyLimit,
    limiter: new Ratelimit({
      redis: redis!,
      limiter: Ratelimit.tokenBucket(monthlyMicro, "30 d", monthlyMicro),
      prefix: "usage:monthly",
    }),
    key: `${userId}:${subscription}`,
  };
};

/**
 * Check rate limit using token bucket and deduct estimated input cost upfront.
 * Uses a single monthly budget for all paid users (Pro, Pro+, Ultra, Team).
 * Supports extra usage charging when the monthly limit is exceeded.
 */
export const checkTokenBucketLimit = async (
  userId: string,
  subscription: SubscriptionTier,
  estimatedInputTokens: number = 0,
  extraUsageConfig?: ExtraUsageConfig,
  modelName?: string,
): Promise<RateLimitInfo> => {
  const redis = createRedisClient();

  if (!redis) {
    throw new ChatSDKError(
      "rate_limit:chat",
      "Rate limiting service is temporarily unavailable. Please try again in a few moments.",
    );
  }

  try {
    const { limiter, key, monthlyLimit } = createRateLimiter(
      redis,
      userId,
      subscription,
    );

    if (subscription === "free" || monthlyLimit === 0) {
      throw new ChatSDKError(
        "rate_limit:chat",
        "Agent mode is not available on the free tier. Upgrade to Pro for agent mode access.",
      );
    }

    const estimatedCost = calculateTokenCost(
      estimatedInputTokens,
      "input",
      modelName,
    );
    const estimatedCostMicro = dollarsToMicro(estimatedCost);

    // Step 1: Peek at current state without deducting (rate: 0)
    const check = await limiter.limit(key, { rate: 0 });

    // Step 2: Check capacity or try extra usage
    const shortfallMicro = Math.max(0, estimatedCostMicro - check.remaining);
    const shortfallDollars = microToDollars(shortfallMicro);

    if (shortfallMicro > 0) {
      // Try extra usage (prepaid balance)
      if (
        extraUsageConfig?.enabled &&
        (extraUsageConfig.hasBalance || extraUsageConfig.autoReloadEnabled)
      ) {
        const deductResult = await deductFromBalance(userId, shortfallDollars);

        if (deductResult.success) {
          // Deduct only the subscription-covered portion from the bucket
          const bucketDeductMicro = estimatedCostMicro - shortfallMicro;
          const result = await limiter.limit(key, { rate: bucketDeductMicro });

          return {
            remaining: result.remaining,
            resetTime: new Date(result.reset),
            limit: dollarsToMicro(monthlyLimit),
            amountDeducted: microToDollars(bucketDeductMicro),
            extraUsageAmountDeducted: shortfallDollars,
          };
        }

        // Deduction failed
        if (deductResult.insufficientFunds) {
          const resetTime = formatTimeRemaining(new Date(check.reset));

          if (deductResult.monthlyCapExceeded) {
            throw new ChatSDKError(
              "rate_limit:chat",
              `You've hit your monthly extra usage spending limit.\n\nYour limit resets in ${resetTime}. To keep going now, increase your spending limit in Settings.`,
            );
          }

          const upgradeHint =
            subscription === "pro"
              ? " or upgrade to Pro+ or Ultra for higher limits"
              : subscription === "pro-plus"
                ? " or upgrade to Ultra for higher limits"
                : "";
          throw new ChatSDKError(
            "rate_limit:chat",
            `You've hit your usage limit and your extra usage balance is empty.\n\nYour limit resets in ${resetTime}. To keep going now, add credits in Settings${upgradeHint}.`,
          );
        }
      }

      // No extra usage — standard rate limit error
      const resetTime = formatTimeRemaining(new Date(check.reset));
      const upgradeHint =
        subscription === "pro"
          ? " or upgrade to Pro+ or Ultra for higher limits"
          : subscription === "pro-plus"
            ? " or upgrade to Ultra for higher limits"
            : "";

      throw new ChatSDKError(
        "rate_limit:chat",
        `You've hit your usage limit.\n\nYour limit resets in ${resetTime}. To keep going now, add extra usage credits in Settings${upgradeHint}.`,
      );
    }

    // Step 3: Have capacity — deduct estimated cost
    const result = await limiter.limit(key, { rate: estimatedCostMicro });

    return {
      remaining: result.remaining,
      resetTime: new Date(result.reset),
      limit: dollarsToMicro(monthlyLimit),
      amountDeducted: estimatedCost,
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
 * Deduct additional cost after processing (output + any input difference).
 * If extra usage was used for input (bucket at 0), also deducts output from extra usage.
 * If we over-estimated input cost, refunds the difference back to the bucket.
 *
 * @param providerCostDollars - If provided (from usage.raw.cost), uses this instead of token calculation
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
): Promise<void> => {
  const redis = createRedisClient();
  if (!redis) return;

  try {
    const { limiter, key, monthlyLimit } = createRateLimiter(
      redis,
      userId,
      subscription,
    );
    if (monthlyLimit === 0) return;

    // Calculate estimated input cost in dollars (already deducted upfront)
    const estimatedInputCost = calculateTokenCost(
      estimatedInputTokens,
      "input",
      modelName,
    );

    // Calculate actual cost in dollars
    let actualCostDollars: number;

    if (providerCostDollars !== undefined && providerCostDollars > 0) {
      actualCostDollars = providerCostDollars;
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
      actualCostDollars = actualInputCost + outputCost;
    }

    const costDifference = actualCostDollars - estimatedInputCost;

    // Over-estimated: refund the difference
    if (costDifference < 0) {
      const refundAmount = Math.abs(costDifference);
      await refundBucketTokens(userId, subscription, refundAmount);
      return;
    }

    // Exact match: nothing to do
    if (costDifference === 0) return;

    // Under-estimated: charge additional
    const additionalCostMicro = dollarsToMicro(costDifference);

    // Check current bucket state
    const bucketCheck = await limiter.limit(key, { rate: 0 });
    const remaining = bucketCheck.remaining;

    // If bucket has capacity, deduct from it
    if (remaining >= additionalCostMicro) {
      await limiter.limit(key, { rate: additionalCostMicro });
      return;
    }

    // Split between bucket and extra usage
    const fromBucket = Math.max(0, remaining);
    const fromExtraUsageMicro = additionalCostMicro - fromBucket;

    if (fromBucket > 0) {
      await limiter.limit(key, { rate: fromBucket });
    }

    // Deduct remainder from extra usage if enabled
    if (
      fromExtraUsageMicro > 0 &&
      extraUsageConfig?.enabled &&
      (extraUsageConfig.hasBalance || extraUsageConfig.autoReloadEnabled)
    ) {
      await deductFromBalance(userId, microToDollars(fromExtraUsageMicro));
    }
  } catch (error) {
    console.error("Failed to deduct usage:", error);
  }
};

/**
 * Refund bucket tokens by adding capacity back to the monthly token bucket.
 * Uses direct Redis operations since Upstash Ratelimit doesn't have a native refund method.
 *
 * @param amountDollars - Amount to refund in dollars
 */
const refundBucketTokens = async (
  userId: string,
  subscription: SubscriptionTier,
  amountDollars: number,
): Promise<void> => {
  if (amountDollars <= 0) return;

  const redis = createRedisClient();
  if (!redis) return;

  const monthlyLimit = getBudgetLimit(subscription);
  const refundMicro = dollarsToMicro(amountDollars);
  const monthlyLimitMicro = dollarsToMicro(monthlyLimit);

  const bucketKey = `usage:monthly:${userId}:${subscription}`;

  try {
    const newTokens = await redis.hincrby(bucketKey, "tokens", refundMicro);

    // Cap at limit if we exceeded it
    if (newTokens > monthlyLimitMicro) {
      await redis.hset(bucketKey, { tokens: monthlyLimitMicro });
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
): Promise<void> => {
  const redis = createRedisClient();
  if (!redis) return;

  const bucketKey = `usage:monthly:${userId}:${subscription}`;

  try {
    await redis.del(bucketKey);
    console.log(
      `[resetRateLimitBuckets] Reset bucket for user ${userId} tier ${subscription}`,
    );
  } catch (error) {
    console.error(
      `[resetRateLimitBuckets] Failed to reset bucket for user ${userId}:`,
      error,
    );
  }
};

/**
 * Refund usage when a request fails after credits were deducted.
 * Refunds both token bucket credits and extra usage balance.
 * All amounts are in dollars.
 */
export const refundUsage = async (
  userId: string,
  subscription: SubscriptionTier,
  amountDeducted: number,
  extraUsageAmountDeducted: number,
): Promise<void> => {
  const refundPromises: Promise<void>[] = [];

  if (amountDeducted > 0) {
    refundPromises.push(
      refundBucketTokens(userId, subscription, amountDeducted),
    );
  }

  if (extraUsageAmountDeducted > 0) {
    refundPromises.push(
      refundToBalance(userId, extraUsageAmountDeducted).then(() => {}),
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
