"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import {
  getBudgetLimits,
  getMonthlyBucketKey,
  POINTS_PER_DOLLAR,
  getSubscriptionPrice,
} from "../lib/rate-limit/token-bucket";
import type { SubscriptionTier } from "../types";
import { limitPaidBucket } from "../lib/rate-limit/paid-bucket";

// Cache dynamic imports to avoid re-importing on every action call
let _cachedModules: { Redis: any } | null = null;
async function getCachedModules() {
  if (!_cachedModules) {
    const redisModule = await import("@upstash/redis");
    _cachedModules = {
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
    monthlyStatusConfirmed: v.boolean(),
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
        monthlyStatusConfirmed: true,
        monthly: emptyStatus,
        monthlyBudgetUsd: 0,
      };
    }

    // Check if Redis is configured
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!redisUrl || !redisToken) {
      return {
        monthlyStatusConfirmed: false,
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
      const { Redis } = await getCachedModules();

      const redis = new Redis({
        url: redisUrl,
        token: redisToken,
      });

      const monthlyStorageKey = getMonthlyBucketKey(userId, subscription);
      const monthlyResult = await limitPaidBucket(
        redis,
        monthlyStorageKey,
        monthlyLimit,
        0,
      );
      const cycleAllocation = monthlyResult.limit;
      const monthlyRemaining = Math.min(
        Math.max(0, monthlyResult.remaining),
        cycleAllocation,
      );
      const effectiveMonthlyLimit = cycleAllocation;
      const monthlyUsed = Math.max(0, effectiveMonthlyLimit - monthlyRemaining);

      return {
        monthlyStatusConfirmed: true,
        monthly: {
          remaining: monthlyRemaining,
          limit: effectiveMonthlyLimit,
          used: monthlyUsed,
          usagePercentage:
            effectiveMonthlyLimit > 0
              ? Math.round((monthlyUsed / effectiveMonthlyLimit) * 100)
              : 0,
          resetTime: new Date(monthlyResult.reset).toISOString(),
        },
        monthlyBudgetUsd: effectiveMonthlyLimit / POINTS_PER_DOLLAR,
      };
    } catch (error) {
      console.error("Failed to get rate limit status:", error);
      return {
        monthlyStatusConfirmed: false,
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
