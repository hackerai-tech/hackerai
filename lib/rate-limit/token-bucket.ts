import { Ratelimit } from "@upstash/ratelimit";
import { ChatSDKError } from "@/lib/errors";
import type { SubscriptionTier, RateLimitInfo } from "@/types";
import { createRedisClient, formatTimeRemaining } from "./redis";
import { PRICING } from "@/lib/pricing/features";

// =============================================================================
// Configuration
// =============================================================================

/** Grok 4.1 pricing: $/1M tokens */
const GROK_PRICING = {
  input: 0.2,
  output: 0.5,
  inputLong: 0.4, // >128K context
  outputLong: 1.0,
};

/** Points per dollar (1 point = $0.0001) */
export const POINTS_PER_DOLLAR = 10_000;

/** Long context threshold (128K tokens) */
const LONG_CONTEXT_THRESHOLD = 128_000;

/** Agent mode gets 70% of subscription price */
export const AGENT_BUDGET_ALLOCATION = 0.7;

// =============================================================================
// Cost Calculation
// =============================================================================

/**
 * Calculate point cost for tokens.
 * @param tokens - Number of tokens
 * @param type - "input" or "output"
 * @param isLongContext - Whether context > 128K
 */
export const calculateTokenCost = (
  tokens: number,
  type: "input" | "output",
  isLongContext = false,
): number => {
  if (tokens <= 0) return 0;

  const price =
    type === "input"
      ? isLongContext
        ? GROK_PRICING.inputLong
        : GROK_PRICING.input
      : isLongContext
        ? GROK_PRICING.outputLong
        : GROK_PRICING.output;

  return Math.ceil((tokens / 1_000_000) * price * POINTS_PER_DOLLAR);
};

// =============================================================================
// Budget Limits
// =============================================================================

/**
 * Get agent budget limits for a subscription tier.
 * @returns { session: daily budget, weekly: weekly budget } in points
 */
export const getBudgetLimits = (
  subscription: SubscriptionTier,
): { session: number; weekly: number } => {
  if (subscription === "free") return { session: 0, weekly: 0 };

  const monthlyPrice = PRICING[subscription]?.monthly ?? 0;
  const monthlyPoints =
    monthlyPrice * AGENT_BUDGET_ALLOCATION * POINTS_PER_DOLLAR;

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

/** Get monthly agent budget (75% of subscription) */
export const getSubscriptionPrice = (
  subscription: SubscriptionTier,
): number => {
  if (subscription === "free") return 0;
  return (PRICING[subscription]?.monthly ?? 0) * AGENT_BUDGET_ALLOCATION;
};

// =============================================================================
// Rate Limiting
// =============================================================================

/**
 * Create rate limiters for a user.
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
        prefix: "agent_bucket",
      }),
      key: `${userId}:agent:${subscription}`,
    },
    weekly: {
      limiter: new Ratelimit({
        redis: redis!,
        limiter: Ratelimit.tokenBucket(weeklyLimit, "7 d", weeklyLimit),
        prefix: "agent_weekly",
      }),
      key: `${userId}:agent:weekly:${subscription}`,
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

    const isLongContext = estimatedInputTokens > LONG_CONTEXT_THRESHOLD;
    const estimatedCost = calculateTokenCost(
      estimatedInputTokens,
      "input",
      isLongContext,
    );

    // Deduct from weekly first
    const weeklyResult = await weekly.limiter.limit(weekly.key, {
      rate: estimatedCost,
    });
    if (!weeklyResult.success) {
      throw new ChatSDKError(
        "rate_limit:chat",
        `You've reached your weekly agent limit, please try again after ${formatTimeRemaining(new Date(weeklyResult.reset))}.\n\nYou can continue using ask mode in the meantime.`,
      );
    }

    // Deduct from session
    const sessionResult = await session.limiter.limit(session.key, {
      rate: estimatedCost,
    });
    if (!sessionResult.success) {
      const msg =
        subscription === "pro"
          ? `You've reached your session limit, please try again after ${formatTimeRemaining(new Date(sessionResult.reset))}.\n\nYou can continue using ask mode in the meantime or upgrade to Ultra for higher limits.`
          : `You've reached your session limit, please try again after ${formatTimeRemaining(new Date(sessionResult.reset))}.\n\nYou can continue using ask mode in the meantime.`;
      throw new ChatSDKError("rate_limit:chat", msg);
    }

    return {
      remaining: Math.min(sessionResult.remaining, weeklyResult.remaining),
      resetTime: new Date(Math.min(sessionResult.reset, weeklyResult.reset)),
      limit: Math.min(sessionLimit, weeklyLimit),
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

    const isLongContext = actualInputTokens > LONG_CONTEXT_THRESHOLD;

    // Calculate additional cost
    const estimatedInputCost = calculateTokenCost(
      estimatedInputTokens,
      "input",
      isLongContext,
    );
    const actualInputCost = calculateTokenCost(
      actualInputTokens,
      "input",
      isLongContext,
    );
    const outputCost = calculateTokenCost(
      actualOutputTokens,
      "output",
      isLongContext,
    );
    const additionalCost =
      Math.max(0, actualInputCost - estimatedInputCost) + outputCost;

    if (additionalCost <= 0) return;

    // Deduct from both buckets
    await session.limiter.limit(session.key, { rate: additionalCost });
    await weekly.limiter.limit(weekly.key, { rate: additionalCost });
  } catch {
    // Silently fail for post-request deductions
  }
};
