import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";

const RECENT_USAGE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_REASON_DETAILS_LENGTH = 2_000;

const subscriptionTierValidator = v.union(
  v.literal("free"),
  v.literal("pro"),
  v.literal("pro-plus"),
  v.literal("ultra"),
  v.literal("team"),
);

const reasonCategoryValidator = v.union(
  v.literal("too_expensive"),
  v.literal("not_using_enough"),
  v.literal("missing_feature"),
  v.literal("results_not_good_enough"),
  v.literal("too_slow_or_unreliable"),
  v.literal("hit_usage_limits"),
  v.literal("switched_tool"),
  v.literal("temporary_pause"),
  v.literal("other"),
);

const usageSegmentValidator = v.union(
  v.literal("none"),
  v.literal("light"),
  v.literal("moderate"),
  v.literal("heavy"),
);

type RecentUsageSegment = "none" | "light" | "moderate" | "heavy";
type CancellationReasonCategory =
  | "too_expensive"
  | "not_using_enough"
  | "missing_feature"
  | "results_not_good_enough"
  | "too_slow_or_unreliable"
  | "hit_usage_limits"
  | "switched_tool"
  | "temporary_pause"
  | "other";

function usageSegment(requestCount: number): RecentUsageSegment {
  if (requestCount <= 0) return "none";
  if (requestCount <= 10) return "light";
  if (requestCount <= 50) return "moderate";
  return "heavy";
}

function normalizeReasonDetails(details: string): string {
  const normalized = details.trim().slice(0, MAX_REASON_DETAILS_LENGTH);
  if (!normalized) {
    throw new Error("Cancellation reason details are required");
  }
  return normalized;
}

async function recentUsageSummary(
  ctx: MutationCtx,
  userId: string,
  now: number,
) {
  const startTime = now - RECENT_USAGE_DAYS * MS_PER_DAY;
  const logs = await ctx.db
    .query("usage_logs")
    .withIndex("by_user", (q) =>
      q.eq("user_id", userId).gte("_creationTime", startTime),
    )
    .collect();

  const requestCount = logs.length;
  const costDollars = logs.reduce(
    (sum, log) => sum + (log.cost_dollars ?? 0),
    0,
  );
  const totalTokens = logs.reduce(
    (sum, log) => sum + (log.total_tokens ?? 0),
    0,
  );

  return {
    requestCount,
    costDollars,
    totalTokens,
    segment: usageSegment(requestCount),
  };
}

export const recordCancellationStarted = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    organizationId: v.optional(v.string()),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    stripePriceId: v.optional(v.string()),
    plan: v.optional(v.string()),
    subscriptionTier: v.optional(subscriptionTierValidator),
    reasonCategory: reasonCategoryValidator,
    reasonDetails: v.string(),
    accountCreatedAt: v.optional(v.number()),
    accountAgeDays: v.optional(v.number()),
    startedAt: v.optional(v.number()),
  },
  returns: v.id("cancellation_reasons"),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const now = args.startedAt ?? Date.now();
    const recentUsage = await recentUsageSummary(ctx, args.userId, now);
    const reasonDetails = normalizeReasonDetails(args.reasonDetails);

    return await ctx.db.insert("cancellation_reasons", {
      user_id: args.userId,
      organization_id: args.organizationId,
      stripe_customer_id: args.stripeCustomerId,
      stripe_subscription_id: args.stripeSubscriptionId,
      stripe_price_id: args.stripePriceId,
      plan: args.plan,
      subscription_tier: args.subscriptionTier,
      reason_category: args.reasonCategory,
      reason_details: reasonDetails,
      status: "started",
      source: "billing_portal",
      started_at: now,
      account_created_at: args.accountCreatedAt,
      account_age_days: args.accountAgeDays,
      recent_usage_days: RECENT_USAGE_DAYS,
      recent_usage_request_count: recentUsage.requestCount,
      recent_usage_cost_dollars: recentUsage.costDollars,
      recent_usage_total_tokens: recentUsage.totalTokens,
      recent_usage_segment: recentUsage.segment,
      updated_at: now,
    });
  },
});

export const markCancellationCompleted = mutation({
  args: {
    serviceKey: v.string(),
    stripeSubscriptionId: v.string(),
    stripeCustomerId: v.optional(v.string()),
    userIds: v.optional(v.array(v.string())),
    organizationId: v.optional(v.string()),
    subscriptionTier: v.optional(subscriptionTierValidator),
    stripeCancellationReason: v.optional(v.string()),
    cancelAtPeriodEnd: v.optional(v.boolean()),
    completedAt: v.optional(v.number()),
  },
  returns: v.object({
    matchedCount: v.number(),
    updatedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const rows = await ctx.db
      .query("cancellation_reasons")
      .withIndex("by_stripe_subscription_id", (q) =>
        q.eq("stripe_subscription_id", args.stripeSubscriptionId),
      )
      .collect();

    const userIdSet = args.userIds ? new Set(args.userIds) : null;
    const candidates = rows
      .filter((row) => row.status !== "completed")
      .filter((row) => !userIdSet || userIdSet.has(row.user_id))
      .sort((a, b) => b.started_at - a.started_at);

    const target = candidates[0];
    if (!target) {
      return { matchedCount: rows.length, updatedCount: 0 };
    }

    const completedAt = args.completedAt ?? Date.now();
    await ctx.db.patch(target._id, {
      status: "completed",
      completed_at: completedAt,
      stripe_customer_id: args.stripeCustomerId ?? target.stripe_customer_id,
      organization_id: args.organizationId ?? target.organization_id,
      subscription_tier: args.subscriptionTier ?? target.subscription_tier,
      stripe_cancellation_reason: args.stripeCancellationReason,
      cancel_at_period_end: args.cancelAtPeriodEnd,
      updated_at: completedAt,
    });

    return { matchedCount: rows.length, updatedCount: 1 };
  },
});

export const getCancellationReasonReport = query({
  args: {
    serviceKey: v.string(),
    startAt: v.optional(v.number()),
    endAt: v.optional(v.number()),
    subscriptionTier: v.optional(subscriptionTierValidator),
    recentUsageSegment: v.optional(usageSegmentValidator),
  },
  returns: v.array(
    v.object({
      plan: v.string(),
      subscriptionTier: v.string(),
      recentUsageSegment: usageSegmentValidator,
      reasonCategory: reasonCategoryValidator,
      startedCount: v.number(),
      completedCount: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const rows = await ctx.db
      .query("cancellation_reasons")
      .withIndex("by_started_at", (q) => {
        if (args.startAt !== undefined && args.endAt !== undefined) {
          return q
            .gte("started_at", args.startAt)
            .lte("started_at", args.endAt);
        }
        if (args.startAt !== undefined) {
          return q.gte("started_at", args.startAt);
        }
        if (args.endAt !== undefined) {
          return q.lte("started_at", args.endAt);
        }
        return q;
      })
      .collect();

    const groups = new Map<
      string,
      {
        plan: string;
        subscriptionTier: string;
        recentUsageSegment: RecentUsageSegment;
        reasonCategory: CancellationReasonCategory;
        startedCount: number;
        completedCount: number;
      }
    >();

    for (const row of rows) {
      if (
        args.subscriptionTier &&
        row.subscription_tier !== args.subscriptionTier
      ) {
        continue;
      }
      if (
        args.recentUsageSegment &&
        row.recent_usage_segment !== args.recentUsageSegment
      ) {
        continue;
      }

      const plan = row.plan ?? "unknown";
      const tier = row.subscription_tier ?? "unknown";
      const key = [
        plan,
        tier,
        row.recent_usage_segment,
        row.reason_category,
      ].join("|");
      const group = groups.get(key) ?? {
        plan,
        subscriptionTier: tier,
        recentUsageSegment: row.recent_usage_segment,
        reasonCategory: row.reason_category,
        startedCount: 0,
        completedCount: 0,
      };

      group.startedCount += 1;
      if (row.status === "completed") {
        group.completedCount += 1;
      }
      groups.set(key, group);
    }

    return Array.from(groups.values()).sort((a, b) => {
      const tierCompare = a.subscriptionTier.localeCompare(b.subscriptionTier);
      if (tierCompare !== 0) return tierCompare;
      const segmentCompare = a.recentUsageSegment.localeCompare(
        b.recentUsageSegment,
      );
      if (segmentCompare !== 0) return segmentCompare;
      return b.startedCount - a.startedCount;
    });
  },
});
