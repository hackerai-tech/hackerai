import { Ratelimit } from "@upstash/ratelimit";
import { ChatSDKError } from "@/lib/errors";
import type {
  SubscriptionTier,
  RateLimitInfo,
  ExtraUsageConfig,
} from "@/types";
import { createRedisClient, formatTimeRemaining } from "./redis";
import { deductFromBalance, refundToBalance } from "@/lib/extra-usage";

// =============================================================================
// Configuration
// =============================================================================

/** Model pricing: $/1M tokens per model (default used for ask models + gemini 3 flash agent) */
const MODEL_PRICING_MAP: Record<string, { input: number; output: number }> = {
  default: { input: 0.5, output: 3.0 },
  "model-sonnet-4.6": { input: 3.0, output: 15.0 },
  "model-gemini-3.1-pro": { input: 2.0, output: 12.0 },
  "model-grok-4.1": { input: 0.2, output: 0.5 },
  "model-gemini-3-flash": { input: 0.5, output: 3.0 },
  "model-gpt-5.4": { input: 2.5, output: 15.0 },
};

const getModelPricing = (modelName?: string) =>
  (modelName && MODEL_PRICING_MAP[modelName]) || MODEL_PRICING_MAP.default;

/** Points per dollar (1 point = $0.0001) */
export const POINTS_PER_DOLLAR = 10_000;

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
): Promise<RateLimitInfo> => {
  const redis = createRedisClient();

  if (!redis) {
    throw new ChatSDKError(
      "rate_limit:chat",
      "Rate limiting service is temporarily unavailable. Please try again in a few moments.",
    );
  }

  try {
    const { monthly, monthlyLimit } = createRateLimiter(
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

    const upgradeHint =
      subscription === "pro"
        ? " or upgrade to Pro+ or Ultra for higher limits"
        : subscription === "pro-plus"
          ? " or upgrade to Ultra for higher limits"
          : "";

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
    const monthlyCheck = await monthly.limiter.limit(monthly.key, { rate: 0 });

    // Step 2: Check if we have enough capacity, or if we need extra usage
    const shortfall = Math.max(0, estimatedCost - monthlyCheck.remaining);

    // If we're over limit, try extra usage (prepaid balance)
    if (shortfall > 0) {
      if (
        extraUsageConfig?.enabled &&
        (extraUsageConfig.hasBalance || extraUsageConfig.autoReloadEnabled)
      ) {
        const deductResult = await deductFromBalance(userId, shortfall);

        if (deductResult.success) {
          // Extra usage covered the shortfall. Deduct only what subscription contributed.
          const bucketDeduct = estimatedCost - shortfall;

          const monthlyResult = await monthly.limiter.limit(monthly.key, {
            rate: bucketDeduct,
          });

          return buildResult(monthlyResult, bucketDeduct, shortfall);
        }

        // Deduction failed - check why
        if (deductResult.insufficientFunds) {
          const resetTime = formatTimeRemaining(new Date(monthlyCheck.reset));

          if (deductResult.monthlyCapExceeded) {
            const msg = `You've hit your monthly extra usage spending limit.\n\nYour limit resets ${resetTime}. To keep going now, increase your spending limit in Settings.`;
            throw new ChatSDKError("rate_limit:chat", msg);
          }

          const msg = `You've hit your usage limit and your extra usage balance is empty.\n\nYour limit resets ${resetTime}. To keep going now, add credits in Settings${upgradeHint}.`;
          throw new ChatSDKError("rate_limit:chat", msg);
        }

        // Fall through to standard rate limit error
      }

      // No extra usage enabled - throw standard rate limit error
      const resetTime = formatTimeRemaining(new Date(monthlyCheck.reset));
      const msg = `You've hit your monthly usage limit.\n\nYour limit resets ${resetTime}. To keep going now, add extra usage credits in Settings${upgradeHint}.`;
      throw new ChatSDKError("rate_limit:chat", msg);
    }

    // Step 3: Have capacity, deduct from monthly bucket
    const monthlyResult = await monthly.limiter.limit(monthly.key, {
      rate: estimatedCost,
    });

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

    // Calculate actual cost - prefer provider cost if available
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
      actualCostPoints = actualInputCost + outputCost;
    }

    // Calculate the difference between what we pre-deducted and actual cost
    const costDifference = actualCostPoints - estimatedInputCost;

    // If we over-estimated (pre-deducted more than actual), refund the difference
    if (costDifference < 0) {
      const refundAmount = Math.abs(costDifference);
      await refundBucketTokens(userId, subscription, refundAmount);
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
      await deductFromBalance(userId, fromExtraUsage);
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

  const monthlyKey = `usage:monthly:${userId}:${subscription}`;

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
): Promise<void> => {
  const redis = createRedisClient();
  if (!redis) return;

  const monthlyKey = `usage:monthly:${userId}:${subscription}`;

  try {
    await redis.del(monthlyKey);

    // Re-seed the Upstash TTL so it aligns with this reset. The limit()
    // call creates a fresh bucket, and the explicit expire() guarantees
    // exactly 30 days regardless of any Upstash TTL drift.
    const { monthly } = createRateLimiter(redis, userId, subscription);
    await monthly.limiter.limit(monthly.key, { rate: 0 });
    await redis.expire(monthlyKey, 30 * 24 * 60 * 60);

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
 */
export const refundUsage = async (
  userId: string,
  subscription: SubscriptionTier,
  pointsDeducted: number,
  extraUsagePointsDeducted: number,
): Promise<void> => {
  const refundPromises: Promise<void>[] = [];

  if (pointsDeducted > 0) {
    refundPromises.push(
      refundBucketTokens(userId, subscription, pointsDeducted),
    );
  }

  if (extraUsagePointsDeducted > 0) {
    refundPromises.push(
      refundToBalance(userId, extraUsagePointsDeducted).then(() => {}),
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
