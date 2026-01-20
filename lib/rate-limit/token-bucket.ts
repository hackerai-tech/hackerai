import { Ratelimit } from "@upstash/ratelimit";
import { ChatSDKError } from "@/lib/errors";
import type { SubscriptionTier, RateLimitInfo } from "@/types";
import { createRedisClient, formatTimeRemaining } from "./redis";
import { PRICING } from "@/lib/pricing/features";

// =============================================================================
// Configuration
// =============================================================================

/** Model pricing: $/1M tokens (same model for default and agent vision) */
const MODEL_PRICING = {
  input: 0.5,
  output: 3.0,
  // TODO: Re-enable long context pricing when needed
  // inputLong: 1.0, // >128K context (2x input)
  // outputLong: 6.0, // >128K context (2x output)
};

/** Points per dollar (1 point = $0.0001) */
export const POINTS_PER_DOLLAR = 10_000;

// /** Long context threshold (128K tokens) */
// const LONG_CONTEXT_THRESHOLD = 128_000;

// =============================================================================
// Cost Calculation
// =============================================================================

/**
 * Calculate point cost for tokens.
 * @param tokens - Number of tokens
 * @param type - "input" or "output"
 * // @param isLongContext - Whether context > 128K (reserved for future use)
 * // @param modelName - Model name (reserved for future use when models differ)
 */
export const calculateTokenCost = (
  tokens: number,
  type: "input" | "output",
  // isLongContext = false,
  // modelName = "",
): number => {
  if (tokens <= 0) return 0;

  // TODO: Re-enable long context pricing when needed
  // const price =
  //   type === "input"
  //     ? isLongContext ? MODEL_PRICING.inputLong : MODEL_PRICING.input
  //     : isLongContext ? MODEL_PRICING.outputLong : MODEL_PRICING.output;

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
 */
export const checkAgentRateLimit = async (
  userId: string,
  subscription: SubscriptionTier,
  estimatedInputTokens: number = 0,
  // modelName = "",
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

    // Step 2: Validate both limits have enough capacity
    if (weeklyCheck.remaining < estimatedCost) {
      const msg =
        subscription === "pro"
          ? `You've reached your weekly limit, please try again after ${formatTimeRemaining(new Date(weeklyCheck.reset))}.\n\nUpgrade to Ultra for higher limits.`
          : `You've reached your weekly limit, please try again after ${formatTimeRemaining(new Date(weeklyCheck.reset))}.`;
      throw new ChatSDKError("rate_limit:chat", msg);
    }

    if (sessionCheck.remaining < estimatedCost) {
      const msg =
        subscription === "pro"
          ? `You've reached your session limit, please try again after ${formatTimeRemaining(new Date(sessionCheck.reset))}.\n\nUpgrade to Ultra for higher limits.`
          : `You've reached your session limit, please try again after ${formatTimeRemaining(new Date(sessionCheck.reset))}.`;
      throw new ChatSDKError("rate_limit:chat", msg);
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
 */
export const deductAgentUsage = async (
  userId: string,
  subscription: SubscriptionTier,
  estimatedInputTokens: number,
  actualInputTokens: number,
  actualOutputTokens: number,
  // modelName = "",
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

    // const isLongContext = actualInputTokens > LONG_CONTEXT_THRESHOLD;

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

    // Deduct from both buckets in parallel
    await Promise.all([
      session.limiter.limit(session.key, { rate: additionalCost }),
      weekly.limiter.limit(weekly.key, { rate: additionalCost }),
    ]);
  } catch {
    // Silently fail for post-request deductions
  }
};
