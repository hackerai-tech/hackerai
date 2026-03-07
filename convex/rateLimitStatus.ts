"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import {
  getBudgetLimit,
  getSubscriptionPrice,
} from "../lib/rate-limit/token-bucket";
import type { SubscriptionTier } from "../types";

/**
 * Get the current rate limit status for the authenticated user.
 * Returns monthly usage data in dollars.
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
    usedDollars: v.number(),
    includedDollars: v.number(),
    remainingDollars: v.number(),
    usagePercentage: v.number(),
    resetTime: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthenticated: User must be logged in");
    }

    const userId = identity.subject;
    const subscription = args.subscription as SubscriptionTier;
    const monthlyBudget = getSubscriptionPrice(subscription);

    if (subscription === "free" || monthlyBudget === 0) {
      return {
        usedDollars: 0,
        includedDollars: 0,
        remainingDollars: 0,
        usagePercentage: 0,
        resetTime: null,
      };
    }

    const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!redisUrl || !redisToken) {
      return {
        usedDollars: 0,
        includedDollars: monthlyBudget,
        remainingDollars: monthlyBudget,
        usagePercentage: 0,
        resetTime: null,
      };
    }

    try {
      const ratelimitModule = await import("@upstash/ratelimit");
      const Ratelimit = ratelimitModule.default.Ratelimit;
      const { Redis } = await import("@upstash/redis");

      const redis = new Redis({ url: redisUrl, token: redisToken });

      const monthlyLimitMicro = Math.ceil(monthlyBudget * 1_000_000);

      const monthlyRatelimit = new Ratelimit({
        redis,
        limiter: Ratelimit.tokenBucket(
          monthlyLimitMicro,
          "30 d",
          monthlyLimitMicro,
        ),
        prefix: "usage:monthly",
      });

      const key = `${userId}:${subscription}`;
      const result = await monthlyRatelimit.limit(key, { rate: 0 });

      const remainingMicro = Math.min(
        Math.max(0, result.remaining),
        monthlyLimitMicro,
      );
      const usedMicro = monthlyLimitMicro - remainingMicro;

      const usedDollars = usedMicro / 1_000_000;
      const remainingDollars = remainingMicro / 1_000_000;

      return {
        usedDollars: Math.round(usedDollars * 100) / 100,
        includedDollars: monthlyBudget,
        remainingDollars: Math.round(remainingDollars * 100) / 100,
        usagePercentage: Math.round((usedMicro / monthlyLimitMicro) * 100),
        resetTime: new Date(result.reset).toISOString(),
      };
    } catch (error) {
      console.error("Failed to get rate limit status:", error);
      return {
        usedDollars: 0,
        includedDollars: monthlyBudget,
        remainingDollars: monthlyBudget,
        usagePercentage: 0,
        resetTime: null,
      };
    }
  },
});
