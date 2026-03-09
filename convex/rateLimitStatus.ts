"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import {
  getBudgetLimits,
  getSubscriptionPrice,
} from "../lib/rate-limit/token-bucket";
import type { SubscriptionTier } from "../types";

// Cache dynamic imports to avoid re-importing on every action call
let _cachedModules: { Ratelimit: any; Redis: any } | null = null;
async function getCachedModules() {
  if (!_cachedModules) {
    const ratelimitModule = await import("@upstash/ratelimit");
    const redisModule = await import("@upstash/redis");
    _cachedModules = {
      Ratelimit: ratelimitModule.default.Ratelimit,
      Redis: redisModule.Redis,
    };
  }
  return _cachedModules;
}

/**
 * Get the current rate limit status for the authenticated user.
 *
 * Returns monthly limit status.
 */
export const getAgentRateLimitStatus = action({
  args: {
    subscription: v.union(
      v.literal("free"),
      v.literal("pro"),
      v.literal("pro-plus"),
      v.literal("team"),
      v.literal("ultra"),
    ),
  },
  returns: v.object({
    monthly: v.object({
      remaining: v.number(),
      limit: v.number(),
      used: v.number(),
      usagePercentage: v.number(),
      resetTime: v.union(v.string(), v.null()),
    }),
    monthlyBudgetUsd: v.number(),
  }),
  handler: async (ctx, args) => {
    // Authenticate user
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthenticated: User must be logged in");
    }

    const userId = identity.subject;
    const subscription = args.subscription as SubscriptionTier;

    // Calculate limits using shared token-bucket logic
    const { monthly: monthlyLimit } = getBudgetLimits(subscription);
    const monthlyBudgetUsd = getSubscriptionPrice(subscription);

    const emptyStatus: {
      remaining: number;
      limit: number;
      used: number;
      usagePercentage: number;
      resetTime: string | null;
    } = {
      remaining: 0,
      limit: 0,
      used: 0,
      usagePercentage: 0,
      resetTime: null,
    };

    // Default response for free tier or no limits
    if (subscription === "free" || monthlyLimit === 0) {
      return {
        monthly: emptyStatus,
        monthlyBudgetUsd: 0,
      };
    }

    // Check if Redis is configured
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!redisUrl || !redisToken) {
      return {
        monthly: {
          remaining: monthlyLimit,
          limit: monthlyLimit,
          used: 0,
          usagePercentage: 0,
          resetTime: null,
        },
        monthlyBudgetUsd,
      };
    }

    try {
      // Dynamic imports in Convex Node runtime expose modules via .default.
      // Cache at module level to avoid re-importing on every call.
      const { Ratelimit, Redis } = await getCachedModules();

      const redis = new Redis({
        url: redisUrl,
        token: redisToken,
      });

      const monthlyRatelimit = new Ratelimit({
        redis,
        limiter: Ratelimit.tokenBucket(monthlyLimit, "30 d", monthlyLimit),
        prefix: "usage:monthly",
      });

      const monthlyKey = `${userId}:${subscription}`;
      const monthlyResult = await monthlyRatelimit.limit(monthlyKey, {
        rate: 0,
      });

      const monthlyRemaining = Math.min(
        Math.max(0, monthlyResult.remaining),
        monthlyLimit,
      );
      const monthlyUsed = monthlyLimit - monthlyRemaining;

      return {
        monthly: {
          remaining: monthlyRemaining,
          limit: monthlyLimit,
          used: monthlyUsed,
          usagePercentage: Math.round((monthlyUsed / monthlyLimit) * 100),
          resetTime: new Date(monthlyResult.reset).toISOString(),
        },
        monthlyBudgetUsd,
      };
    } catch (error) {
      console.error("Failed to get rate limit status:", error);
      return {
        monthly: {
          remaining: monthlyLimit,
          limit: monthlyLimit,
          used: 0,
          usagePercentage: 0,
          resetTime: null,
        },
        monthlyBudgetUsd,
      };
    }
  },
});
