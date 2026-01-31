"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import {
  getBudgetLimits,
  getSubscriptionPrice,
} from "../lib/rate-limit/token-bucket";
import type { SubscriptionTier } from "../types";

/**
 * Get the current rate limit status for the authenticated user.
 *
 * Returns both session (5-hour) and weekly limit status.
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
    session: v.object({
      remaining: v.number(),
      limit: v.number(),
      used: v.number(),
      usagePercentage: v.number(),
      resetTime: v.union(v.string(), v.null()),
    }),
    weekly: v.object({
      remaining: v.number(),
      limit: v.number(),
      used: v.number(),
      usagePercentage: v.number(),
      resetTime: v.union(v.string(), v.null()),
    }),
    dailyBudgetUsd: v.number(),
    weeklyBudgetUsd: v.number(),
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
    const { session: sessionLimit, weekly: weeklyLimit } =
      getBudgetLimits(subscription);
    const agentBudget = getSubscriptionPrice(subscription);
    const dailyBudgetUsd = agentBudget / 30;
    const weeklyBudgetUsd = (agentBudget * 7) / 30;

    // Default response for free tier or no limits
    const emptyResponse = {
      session: {
        remaining: 0,
        limit: 0,
        used: 0,
        usagePercentage: 0,
        resetTime: null,
      },
      weekly: {
        remaining: 0,
        limit: 0,
        used: 0,
        usagePercentage: 0,
        resetTime: null,
      },
      dailyBudgetUsd: 0,
      weeklyBudgetUsd: 0,
    };

    if (subscription === "free" || sessionLimit === 0) {
      return emptyResponse;
    }

    // Check if Redis is configured
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!redisUrl || !redisToken) {
      return {
        session: {
          remaining: sessionLimit,
          limit: sessionLimit,
          used: 0,
          usagePercentage: 0,
          resetTime: null,
        },
        weekly: {
          remaining: weeklyLimit,
          limit: weeklyLimit,
          used: 0,
          usagePercentage: 0,
          resetTime: null,
        },
        dailyBudgetUsd,
        weeklyBudgetUsd,
      };
    }

    try {
      // Dynamic imports in Convex Node runtime expose modules via .default
      const ratelimitModule = await import("@upstash/ratelimit");
      const Ratelimit = ratelimitModule.default.Ratelimit;

      const { Redis } = await import("@upstash/redis");

      const redis = new Redis({
        url: redisUrl,
        token: redisToken,
      });

      // Query session limit (token bucket)
      // Must match prefix and key format from lib/rate-limit/token-bucket.ts
      const sessionRatelimit = new Ratelimit({
        redis,
        limiter: Ratelimit.tokenBucket(sessionLimit, "5 h", sessionLimit),
        prefix: "usage:session",
      });

      const sessionKey = `${userId}:${subscription}`;
      const sessionResult = await sessionRatelimit.limit(sessionKey, {
        rate: 0,
      });

      // Query weekly limit (token bucket - refills every 7 days)
      // Must match prefix and key format from lib/rate-limit/token-bucket.ts
      const weeklyRatelimit = new Ratelimit({
        redis,
        limiter: Ratelimit.tokenBucket(weeklyLimit, "7 d", weeklyLimit),
        prefix: "usage:weekly",
      });

      const weeklyKey = `${userId}:${subscription}`;
      const weeklyResult = await weeklyRatelimit.limit(weeklyKey, { rate: 0 });

      // Clamp remaining to [0, limit] to handle edge cases where bucket
      // may have more tokens than expected (e.g., limit changes, fresh bucket)
      const sessionRemaining = Math.min(
        Math.max(0, sessionResult.remaining),
        sessionLimit,
      );
      const weeklyRemaining = Math.min(
        Math.max(0, weeklyResult.remaining),
        weeklyLimit,
      );

      const sessionUsed = sessionLimit - sessionRemaining;
      const weeklyUsed = weeklyLimit - weeklyRemaining;

      return {
        session: {
          remaining: sessionRemaining,
          limit: sessionLimit,
          used: sessionUsed,
          usagePercentage: Math.round((sessionUsed / sessionLimit) * 100),
          resetTime: new Date(sessionResult.reset).toISOString(),
        },
        weekly: {
          remaining: weeklyRemaining,
          limit: weeklyLimit,
          used: weeklyUsed,
          usagePercentage: Math.round((weeklyUsed / weeklyLimit) * 100),
          resetTime: new Date(weeklyResult.reset).toISOString(),
        },
        dailyBudgetUsd,
        weeklyBudgetUsd,
      };
    } catch (error) {
      console.error("Failed to get rate limit status:", error);
      return {
        session: {
          remaining: sessionLimit,
          limit: sessionLimit,
          used: 0,
          usagePercentage: 0,
          resetTime: null,
        },
        weekly: {
          remaining: weeklyLimit,
          limit: weeklyLimit,
          used: 0,
          usagePercentage: 0,
          resetTime: null,
        },
        dailyBudgetUsd,
        weeklyBudgetUsd,
      };
    }
  },
});
