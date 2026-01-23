import { Ratelimit } from "@upstash/ratelimit";
import { ChatSDKError } from "@/lib/errors";
import type {
  SubscriptionTier,
  RateLimitInfo,
  ExtraUsageConfig,
} from "@/types";
import { createRedisClient, formatTimeRemaining } from "./redis";
import { PRICING } from "@/lib/pricing/features";
import { deductFromBalance } from "@/lib/extra-usage";

// =============================================================================
// Configuration
// =============================================================================

/** Model pricing: $/1M tokens (same model for default and agent vision) */
const MODEL_PRICING = {
  input: 0.5,
  output: 3.0,
};

/** Points per dollar (1 point = $0.0001) */
export const POINTS_PER_DOLLAR = 10_000;

// =============================================================================
// Cost Calculation
// =============================================================================

/**
 * Calculate point cost for tokens.
 * @param tokens - Number of tokens
 * @param type - "input" or "output"
 */
export const calculateTokenCost = (
  tokens: number,
  type: "input" | "output",
): number => {
  if (tokens <= 0) return 0;
  const price = type === "input" ? MODEL_PRICING.input : MODEL_PRICING.output;
  return Math.ceil((tokens / 1_000_000) * price * POINTS_PER_DOLLAR);
};

// =============================================================================
// Budget Limits
// =============================================================================

/**
 * Get budget limits for a subscription tier (shared between agent and ask modes).
 * @returns { session: daily budget, weekly: weekly budget } in points
 */
export const getBudgetLimits = (
  subscription: SubscriptionTier,
): { session: number; weekly: number } => {
  if (subscription === "free") return { session: 0, weekly: 0 };

  const monthlyPrice = PRICING[subscription]?.monthly ?? 0;
  const monthlyPoints = monthlyPrice * POINTS_PER_DOLLAR;

  return {
    session: Math.round(monthlyPoints / 30), // Daily budget
    weekly: Math.round((monthlyPoints * 7) / 30), // Weekly budget
  };
};

/** @deprecated Use getBudgetLimits instead */
export const calculateBucketLimit = (subscription: SubscriptionTier): number =>
  getBudgetLimits(subscription).session;

/** @deprecated Use getBudgetLimits instead */
export const calculateWeeklyLimit = (subscription: SubscriptionTier): number =>
  getBudgetLimits(subscription).weekly;

/** Get monthly budget (full subscription price, shared between modes) */
export const getSubscriptionPrice = (
  subscription: SubscriptionTier,
): number => {
  if (subscription === "free") return 0;
  return PRICING[subscription]?.monthly ?? 0;
};

// =============================================================================
// Rate Limiting
// =============================================================================

/**
 * Create rate limiters for a user (shared between agent and ask modes).
 */
const createRateLimiters = (
  redis: ReturnType<typeof createRedisClient>,
  userId: string,
  subscription: SubscriptionTier,
) => {
  const { session: sessionLimit, weekly: weeklyLimit } =
    getBudgetLimits(subscription);

  return {
    sessionLimit,
    weeklyLimit,
    session: {
      limiter: new Ratelimit({
        redis: redis!,
        limiter: Ratelimit.tokenBucket(sessionLimit, "5 h", sessionLimit),
        prefix: "usage:session",
      }),
      key: `${userId}:${subscription}`,
    },
    weekly: {
      limiter: new Ratelimit({
        redis: redis!,
        limiter: Ratelimit.tokenBucket(weeklyLimit, "7 d", weeklyLimit),
        prefix: "usage:weekly",
      }),
      key: `${userId}:${subscription}`,
    },
  };
};

/**
 * Check rate limit and deduct estimated input cost upfront.
 * Supports extra usage charging when limit is exceeded.
 */
export const checkAgentRateLimit = async (
  userId: string,
  subscription: SubscriptionTier,
  estimatedInputTokens: number = 0,
  extraUsageConfig?: ExtraUsageConfig,
): Promise<RateLimitInfo> => {
  const redis = createRedisClient();

  if (!redis) {
    return {
      remaining: 999999,
      resetTime: new Date(Date.now() + 5 * 60 * 60 * 1000),
      limit: 999999,
    };
  }

  try {
    const { session, weekly, sessionLimit, weeklyLimit } = createRateLimiters(
      redis,
      userId,
      subscription,
    );

    if (subscription === "free" || sessionLimit === 0) {
      throw new ChatSDKError(
        "rate_limit:chat",
        "Agent mode is not available on the free tier. Upgrade to Pro for agent mode access.",
      );
    }

    // const isLongContext = estimatedInputTokens > LONG_CONTEXT_THRESHOLD;
    const estimatedCost = calculateTokenCost(estimatedInputTokens, "input");

    // Step 1: Check both limits first WITHOUT deducting (rate: 0 peeks at current state)
    // This prevents the race condition where we deduct from weekly but session fails
    const [weeklyCheck, sessionCheck] = await Promise.all([
      weekly.limiter.limit(weekly.key, { rate: 0 }),
      session.limiter.limit(session.key, { rate: 0 }),
    ]);

    // Step 2: Check if we have enough capacity, or if we need extra usage
    const sessionShortfall = Math.max(
      0,
      estimatedCost - sessionCheck.remaining,
    );
    const weeklyShortfall = Math.max(0, estimatedCost - weeklyCheck.remaining);
    const pointsNeeded = Math.max(sessionShortfall, weeklyShortfall);

    // If we're over limit, try extra usage (prepaid balance)
    if (pointsNeeded > 0) {
      // Check if extra usage is enabled and user has balance
      if (extraUsageConfig?.enabled && extraUsageConfig.hasBalance) {
        // Deduct from prepaid balance
        const deductResult = await deductFromBalance(userId, pointsNeeded);

        if (deductResult.success) {
          // Balance deducted - deduct what we can from buckets and continue
          // Deduct only the remaining capacity from each bucket (don't go negative)
          const sessionDeduct = Math.min(estimatedCost, sessionCheck.remaining);
          const weeklyDeduct = Math.min(estimatedCost, weeklyCheck.remaining);

          const [weeklyResult, sessionResult] = await Promise.all([
            weekly.limiter.limit(weekly.key, { rate: weeklyDeduct }),
            session.limiter.limit(session.key, { rate: sessionDeduct }),
          ]);

          return {
            remaining: Math.min(
              sessionResult.remaining,
              weeklyResult.remaining,
            ),
            resetTime: new Date(
              Math.min(sessionResult.reset, weeklyResult.reset),
            ),
            limit: Math.min(sessionLimit, weeklyLimit),
            session: {
              remaining: sessionResult.remaining,
              limit: sessionLimit,
              resetTime: new Date(sessionResult.reset),
            },
            weekly: {
              remaining: weeklyResult.remaining,
              limit: weeklyLimit,
              resetTime: new Date(weeklyResult.reset),
            },
          };
        }

        // Deduction failed - check why
        if (deductResult.insufficientFunds) {
          const resetTime =
            sessionShortfall > 0
              ? formatTimeRemaining(new Date(sessionCheck.reset))
              : formatTimeRemaining(new Date(weeklyCheck.reset));
          const limitType = sessionShortfall > 0 ? "session" : "weekly";

          // Monthly spending cap exceeded - recommend increasing it
          if (deductResult.monthlyCapExceeded) {
            const msg = `You've hit your monthly extra usage spending limit.\n\nYour ${limitType} limit resets in ${resetTime}. To keep going now, increase your spending limit in Settings.`;
            throw new ChatSDKError("rate_limit:chat", msg);
          }

          // Actually out of balance
          const msg =
            subscription === "pro"
              ? `You've hit your usage limit and your extra usage balance is empty.\n\nYour ${limitType} limit resets in ${resetTime}. To keep going now, add credits in Settings or upgrade to Ultra for higher limits.`
              : `You've hit your usage limit and your extra usage balance is empty.\n\nYour ${limitType} limit resets in ${resetTime}. To keep going now, add credits in Settings.`;
          throw new ChatSDKError("rate_limit:chat", msg);
        }

        // Fall through to standard rate limit error
      }

      // No extra usage enabled - throw standard rate limit error
      if (weeklyShortfall > 0) {
        const resetTime = formatTimeRemaining(new Date(weeklyCheck.reset));
        const msg =
          subscription === "pro"
            ? `You've hit your weekly usage limit.\n\nYour limit resets in ${resetTime}. To keep going now, add extra usage credits in Settings or upgrade to Ultra for higher limits.`
            : `You've hit your weekly usage limit.\n\nYour limit resets in ${resetTime}. To keep going now, add extra usage credits in Settings.`;
        throw new ChatSDKError("rate_limit:chat", msg);
      }

      if (sessionShortfall > 0) {
        const resetTime = formatTimeRemaining(new Date(sessionCheck.reset));
        const msg =
          subscription === "pro"
            ? `You've hit your session usage limit.\n\nYour limit resets in ${resetTime}. To keep going now, add extra usage credits in Settings or upgrade to Ultra for higher limits.`
            : `You've hit your session usage limit.\n\nYour limit resets in ${resetTime}. To keep going now, add extra usage credits in Settings.`;
        throw new ChatSDKError("rate_limit:chat", msg);
      }
    }

    // Step 3: Both limits have capacity, now deduct from both atomically
    const [weeklyResult, sessionResult] = await Promise.all([
      weekly.limiter.limit(weekly.key, { rate: estimatedCost }),
      session.limiter.limit(session.key, { rate: estimatedCost }),
    ]);

    return {
      remaining: Math.min(sessionResult.remaining, weeklyResult.remaining),
      resetTime: new Date(Math.min(sessionResult.reset, weeklyResult.reset)),
      limit: Math.min(sessionLimit, weeklyLimit),
      session: {
        remaining: sessionResult.remaining,
        limit: sessionLimit,
        resetTime: new Date(sessionResult.reset),
      },
      weekly: {
        remaining: weeklyResult.remaining,
        limit: weeklyLimit,
        resetTime: new Date(weeklyResult.reset),
      },
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
 * If extra usage was used for input (buckets at 0), also deducts output from extra usage.
 */
export const deductAgentUsage = async (
  userId: string,
  subscription: SubscriptionTier,
  estimatedInputTokens: number,
  actualInputTokens: number,
  actualOutputTokens: number,
  extraUsageConfig?: ExtraUsageConfig,
): Promise<void> => {
  const redis = createRedisClient();
  if (!redis) return;

  try {
    const { session, weekly, sessionLimit } = createRateLimiters(
      redis,
      userId,
      subscription,
    );
    if (sessionLimit === 0) return;

    // Calculate additional cost
    const estimatedInputCost = calculateTokenCost(
      estimatedInputTokens,
      "input",
    );
    const actualInputCost = calculateTokenCost(actualInputTokens, "input");
    const outputCost = calculateTokenCost(actualOutputTokens, "output");
    const additionalCost =
      Math.max(0, actualInputCost - estimatedInputCost) + outputCost;

    if (additionalCost <= 0) return;

    // Check current bucket state to see if we need extra usage
    const [sessionCheck, weeklyCheck] = await Promise.all([
      session.limiter.limit(session.key, { rate: 0 }),
      weekly.limiter.limit(weekly.key, { rate: 0 }),
    ]);

    const sessionRemaining = sessionCheck.remaining;
    const weeklyRemaining = weeklyCheck.remaining;
    const minRemaining = Math.min(sessionRemaining, weeklyRemaining);

    // If buckets have capacity, deduct from them
    if (minRemaining >= additionalCost) {
      await Promise.all([
        session.limiter.limit(session.key, { rate: additionalCost }),
        weekly.limiter.limit(weekly.key, { rate: additionalCost }),
      ]);
      return;
    }

    // Split between buckets and extra usage
    const fromBuckets = Math.max(0, minRemaining);
    const fromExtraUsage = additionalCost - fromBuckets;

    // Deduct what we can from buckets
    if (fromBuckets > 0) {
      await Promise.all([
        session.limiter.limit(session.key, { rate: fromBuckets }),
        weekly.limiter.limit(weekly.key, { rate: fromBuckets }),
      ]);
    }

    // Deduct remainder from extra usage if enabled
    if (
      fromExtraUsage > 0 &&
      extraUsageConfig?.enabled &&
      extraUsageConfig.hasBalance
    ) {
      await deductFromBalance(userId, fromExtraUsage);
    }
  } catch {
    // Silently fail for post-request deductions
  }
};
