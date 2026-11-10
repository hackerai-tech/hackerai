import {
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./lib/serviceFunctions";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";
import type { Doc } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";

const RECENT_USAGE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_REASON_DETAILS_LENGTH = 2_000;
const MAX_RECENT_USAGE_LOGS = 5_000;
const MAX_REPORT_ROWS = 10_000;
const MAX_FEEDBACK_EXPORT_ROWS = 10_000;

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

const reasonSubcategoryValidator = v.union(
  v.literal("too_expensive_low_frequency"),
  v.literal("insufficient_included_usage"),
  v.literal("failed_or_incomplete_task"),
  v.literal("slow_or_disconnected_agent"),
  v.literal("wrong_execution_environment"),
  v.literal("model_quality"),
  v.literal("billing_or_renewal"),
  v.literal("missing_capability"),
  v.literal("other"),
);

const usageSegmentValidator = v.union(
  v.literal("none"),
  v.literal("light"),
  v.literal("moderate"),
  v.literal("heavy"),
);

const sourceValidator = v.union(
  v.literal("in_app"),
  v.literal("billing_portal"),
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
type CancellationReasonSubcategory =
  | "too_expensive_low_frequency"
  | "insufficient_included_usage"
  | "failed_or_incomplete_task"
  | "slow_or_disconnected_agent"
  | "wrong_execution_environment"
  | "model_quality"
  | "billing_or_renewal"
  | "missing_capability"
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

async function latestReason(ctx: Pick<QueryCtx, "db">, subscriptionId: string) {
  return ctx.db
    .query("cancellation_reasons")
    .withIndex("by_stripe_subscription_id", (q) =>
      q.eq("stripe_subscription_id", subscriptionId),
    )
    .order("desc")
    .first();
}

/** Apply report limits to current decisions, so history cannot crowd them out. */
async function currentReasons(
  ctx: Pick<QueryCtx, "db">,
  args: { startAt?: number; endAt?: number },
  limit: number,
) {
  const current = await ctx.db
    .query("current_cancellation_reasons")
    .withIndex("by_created_at", (q) => {
      if (args.startAt !== undefined && args.endAt !== undefined)
        return q.gte("created_at", args.startAt).lte("created_at", args.endAt);
      if (args.startAt !== undefined) return q.gte("created_at", args.startAt);
      if (args.endAt !== undefined) return q.lte("created_at", args.endAt);
      return q;
    })
    .order("desc")
    .take(limit);
  const reasons = await Promise.all(
    current.map((row) => ctx.db.get(row.cancellation_reason_id)),
  );
  return reasons.filter(
    (row): row is Doc<"cancellation_reasons"> => row !== null,
  );
}

async function clearCurrentReason(ctx: MutationCtx, subscriptionId: string) {
  const current = await ctx.db
    .query("current_cancellation_reasons")
    .withIndex("by_stripe_subscription_id", (q) =>
      q.eq("stripe_subscription_id", subscriptionId),
    )
    .unique();
  if (current) await ctx.db.delete(current._id);
}

/** Replace the read model atomically; callers must have selected the latest attempt. */
async function publishCurrentReason(
  ctx: MutationCtx,
  row: Doc<"cancellation_reasons">,
) {
  if (!row.stripe_subscription_id) return;
  await clearCurrentReason(ctx, row.stripe_subscription_id);
  if (
    row.status !== "completed" ||
    row.reversed_at !== undefined ||
    row.superseded_at !== undefined ||
    row.retention_offer_accepted ||
    (row.operation && row.operation !== "cancel") ||
    !row.reason_details_id
  )
    return;
  const detail = await ctx.db.get(row.reason_details_id);
  if (!detail) return; // Account deletion removes the private feedback.
  await ctx.db.insert("current_cancellation_reasons", {
    stripe_subscription_id: row.stripe_subscription_id,
    cancellation_reason_id: row._id,
    user_id: row.user_id,
    organization_id: row.organization_id,
    reason_category: row.reason_category,
    reason_subcategory: row.reason_subcategory,
    reason_details: detail.reason_details,
    created_at: row.started_at,
  });
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
    .order("desc")
    .take(MAX_RECENT_USAGE_LOGS);

  const requestCount = logs.length;
  const costDollars = logs.reduce(
    (sum, log) => sum + (log.cost_dollars ?? 0),
    0,
  );
  const totalTokens = logs.reduce(
    (sum, log) => sum + log.input_tokens + log.output_tokens,
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
    operation: v.optional(
      v.union(v.literal("cancel"), v.literal("pause"), v.literal("downgrade")),
    ),
    serviceKey: v.string(),
    userId: v.string(),
    organizationId: v.optional(v.string()),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    stripePriceId: v.optional(v.string()),
    plan: v.optional(v.string()),
    subscriptionTier: v.optional(subscriptionTierValidator),
    reasonCategory: reasonCategoryValidator,
    // Optional during rollout so an older app server can still record the
    // broad reason while the new survey deploy propagates.
    reasonSubcategory: v.optional(reasonSubcategoryValidator),
    reasonDetails: v.string(),
    accountCreatedAt: v.optional(v.number()),
    accountAgeDays: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    source: v.optional(sourceValidator),
  },
  returns: v.id("cancellation_reasons"),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const now = args.startedAt ?? Date.now();
    const reasonDetails = normalizeReasonDetails(args.reasonDetails);
    const operation = args.operation ?? "cancel";
    if (args.stripeSubscriptionId) {
      const latest = await latestReason(ctx, args.stripeSubscriptionId);
      if (
        latest &&
        latest.reversed_at === undefined &&
        latest.superseded_at === undefined
      ) {
        const detail = latest.reason_details_id
          ? await ctx.db.get(latest.reason_details_id)
          : null;
        // Convex serializes this read/insert transaction, so concurrent identical
        // requests and retries after an uncertain Stripe response share one ID.
        if (
          latest.user_id === args.userId &&
          latest.organization_id === args.organizationId &&
          (latest.operation ?? latest.retention_offer_accepted ?? "cancel") ===
            operation &&
          (latest.status === "started" ||
            now <= (latest.completed_at ?? latest.updated_at) + 999) &&
          latest.reason_category === args.reasonCategory &&
          latest.reason_subcategory === args.reasonSubcategory &&
          detail?.reason_details === reasonDetails
        ) {
          return latest._id;
        }
        // Keep edited feedback as a distinct history entry, never overwrite it.
        await ctx.db.patch(latest._id, { superseded_at: now });
      }
      await clearCurrentReason(ctx, args.stripeSubscriptionId);
    }
    const recentUsage = await recentUsageSummary(ctx, args.userId, now);

    const cancellationReasonId = await ctx.db.insert("cancellation_reasons", {
      // Older app servers do not send operation/attempt metadata. Keep their
      // rows distinguishable until both sides of the rollout are upgraded.
      operation: args.operation,
      user_id: args.userId,
      organization_id: args.organizationId,
      stripe_customer_id: args.stripeCustomerId,
      stripe_subscription_id: args.stripeSubscriptionId,
      stripe_price_id: args.stripePriceId,
      plan: args.plan,
      subscription_tier: args.subscriptionTier,
      reason_category: args.reasonCategory,
      reason_subcategory: args.reasonSubcategory,
      status: "started",
      source: args.source ?? "in_app",
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

    const reasonDetailsId = await ctx.db.insert("cancellation_reason_details", {
      cancellation_reason_id: cancellationReasonId,
      user_id: args.userId,
      organization_id: args.organizationId,
      stripe_subscription_id: args.stripeSubscriptionId,
      reason_details: reasonDetails,
      created_at: now,
    });

    await ctx.db.patch(cancellationReasonId, {
      reason_details_id: reasonDetailsId,
    });

    return cancellationReasonId;
  },
});

/**
 * Record that the user accepted a retention offer for a started cancellation.
 * A downgrade keeps the subscription, so the row becomes "retained". A pause
 * still ends the subscription later, so the row stays "started" until the
 * Stripe webhook completes it.
 */
export const recordRetentionOfferAccepted = mutation({
  args: {
    serviceKey: v.string(),
    cancellationReasonId: v.id("cancellation_reasons"),
    retentionOffer: v.union(v.literal("pause"), v.literal("downgrade")),
    acceptedAt: v.optional(v.number()),
  },
  returns: v.object({
    recorded: v.boolean(),
    reason: v.optional(
      v.union(
        v.literal("not_found"),
        v.literal("already_decided"),
        v.literal("different_offer_accepted"),
      ),
    ),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const row = await ctx.db.get(args.cancellationReasonId);
    if (!row) return { recorded: false, reason: "not_found" as const };
    if (row.reversed_at !== undefined || row.superseded_at !== undefined) {
      return { recorded: false, reason: "already_decided" as const };
    }
    // Repeating the same offer is idempotent; a different offer on a row that
    // already accepted one, or a row that already completed, is rejected so
    // the stored state cannot disagree with Stripe.
    if (row.retention_offer_accepted === args.retentionOffer) {
      return { recorded: true };
    }
    if (row.retention_offer_accepted) {
      return { recorded: false, reason: "different_offer_accepted" as const };
    }
    // The pause webhook may arrive before the action records acceptance.
    if (
      row.status !== "started" &&
      !(
        row.status === "completed" &&
        row.operation === "pause" &&
        args.retentionOffer === "pause"
      )
    ) {
      return { recorded: false, reason: "already_decided" as const };
    }

    const acceptedAt = args.acceptedAt ?? Date.now();
    await ctx.db.patch(row._id, {
      retention_offer_accepted: args.retentionOffer,
      ...(args.retentionOffer === "downgrade" && {
        status: "retained" as const,
      }),
      updated_at: acceptedAt,
    });
    if (row.stripe_subscription_id)
      await clearCurrentReason(ctx, row.stripe_subscription_id);
    return { recorded: true };
  },
});

export const markCancellationCompleted = mutation({
  args: {
    cancellationReasonId: v.optional(v.string()),
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
    cancellationReasonId: v.optional(v.id("cancellation_reasons")),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const completedAt = args.completedAt ?? Date.now();
    // Select the latest attempt BEFORE checking its status. Repeated delivery
    // must not walk backwards and complete an older failed/retained attempt.
    const target = await latestReason(ctx, args.stripeSubscriptionId);
    const matchedCount = target ? 1 : 0;
    if (
      !target ||
      target.status !== "started" ||
      target.reversed_at !== undefined ||
      target.superseded_at !== undefined ||
      (!args.cancellationReasonId && target.operation !== undefined) ||
      (args.cancellationReasonId && args.cancellationReasonId !== target._id) ||
      (args.userIds && !args.userIds.includes(target.user_id)) ||
      (args.stripeCustomerId &&
        target.stripe_customer_id !== args.stripeCustomerId) ||
      (args.organizationId && target.organization_id !== args.organizationId) ||
      (args.stripeCancellationReason &&
        args.stripeCancellationReason !== "cancellation_requested") ||
      // Stripe timestamps have second precision. Legacy events without the
      // explicit attempt ID cannot complete attempts from a later second.
      completedAt + 999 < target.started_at
    ) {
      return { matchedCount, updatedCount: 0 };
    }
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
    const completed = await ctx.db.get(target._id);
    if (completed) await publishCurrentReason(ctx, completed);

    return { matchedCount, updatedCount: 1, cancellationReasonId: target._id };
  },
});

export const markCancellationReversed = mutation({
  args: {
    serviceKey: v.string(),
    stripeSubscriptionId: v.string(),
    stripeCustomerId: v.string(),
    cancellationReasonId: v.optional(v.string()),
    reversedAt: v.number(),
  },
  returns: v.object({ updatedCount: v.number() }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await latestReason(ctx, args.stripeSubscriptionId);
    if (
      !row ||
      row.stripe_customer_id !== args.stripeCustomerId ||
      (!args.cancellationReasonId && row.operation !== undefined) ||
      (args.cancellationReasonId && row._id !== args.cancellationReasonId) ||
      args.reversedAt + 999 < row.started_at ||
      row.reversed_at !== undefined
    )
      return { updatedCount: 0 };
    await ctx.db.patch(row._id, {
      reversed_at: args.reversedAt,
      updated_at: args.reversedAt,
    });
    await clearCurrentReason(ctx, args.stripeSubscriptionId);
    return { updatedCount: 1 };
  },
});

// Explicit, paginated rollout reconciliation. The operator compares each
// candidate with live Stripe state; no historical rows or feedback are deleted.
export const getCurrentReasonBackfillPage = query({
  args: { serviceKey: v.string(), paginationOpts: paginationOptsValidator },
  returns: v.object({
    continueCursor: v.string(),
    isDone: v.boolean(),
    page: v.array(
      v.object({
        id: v.id("cancellation_reasons"),
        updatedAt: v.number(),
        subscriptionId: v.string(),
        customerId: v.string(),
        reasonDetails: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const result = await ctx.db
      .query("cancellation_reasons")
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(args.paginationOpts.numItems, 100),
      });
    const page = [];
    for (const row of result.page) {
      if (
        !row.stripe_subscription_id ||
        !row.stripe_customer_id ||
        !row.reason_details_id ||
        row.status !== "completed" ||
        row.reversed_at !== undefined ||
        row.superseded_at !== undefined ||
        row.retention_offer_accepted ||
        (row.operation && row.operation !== "cancel")
      )
        continue;
      const latest = await latestReason(ctx, row.stripe_subscription_id);
      if (latest?._id !== row._id) continue;
      const detail = await ctx.db.get(row.reason_details_id);
      if (detail)
        page.push({
          id: row._id,
          updatedAt: row.updated_at,
          subscriptionId: row.stripe_subscription_id,
          customerId: row.stripe_customer_id,
          reasonDetails: detail.reason_details,
        });
    }
    return {
      page,
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

export const reconcileCurrentCancellationReason = mutation({
  args: {
    serviceKey: v.string(),
    cancellationReasonId: v.id("cancellation_reasons"),
    expectedUpdatedAt: v.number(),
    cancellationActive: v.boolean(),
  },
  returns: v.object({ applied: v.boolean() }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await ctx.db.get(args.cancellationReasonId);
    if (
      !row?.stripe_subscription_id ||
      row.updated_at !== args.expectedUpdatedAt ||
      (await latestReason(ctx, row.stripe_subscription_id))?._id !== row._id
    )
      return { applied: false };
    if (args.cancellationActive) await publishCurrentReason(ctx, row);
    else {
      // Stripe has restored this plan or replaced this cancellation with a pause.
      await ctx.db.patch(row._id, {
        reversed_at: Date.now(),
        updated_at: Date.now(),
      });
      await clearCurrentReason(ctx, row.stripe_subscription_id);
    }
    return { applied: true };
  },
});

export const getCancellationReasonReport = query({
  args: {
    serviceKey: v.string(),
    includeHistory: v.optional(v.boolean()),
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
      reasonSubcategory: v.union(reasonSubcategoryValidator, v.null()),
      startedCount: v.number(),
      completedCount: v.number(),
      retainedCount: v.number(),
      pausedCount: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const rows = args.includeHistory
      ? await ctx.db
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
          .order("desc")
          .take(MAX_REPORT_ROWS)
      : await currentReasons(ctx, args, MAX_REPORT_ROWS);

    const groups = new Map<
      string,
      {
        plan: string;
        subscriptionTier: string;
        recentUsageSegment: RecentUsageSegment;
        reasonCategory: CancellationReasonCategory;
        reasonSubcategory: CancellationReasonSubcategory | null;
        startedCount: number;
        completedCount: number;
        retainedCount: number;
        pausedCount: number;
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
        row.reason_subcategory ?? "unknown",
      ].join("|");
      const group = groups.get(key) ?? {
        plan,
        subscriptionTier: tier,
        recentUsageSegment: row.recent_usage_segment,
        reasonCategory: row.reason_category,
        reasonSubcategory: row.reason_subcategory ?? null,
        startedCount: 0,
        completedCount: 0,
        retainedCount: 0,
        pausedCount: 0,
      };

      group.startedCount += 1;
      if (row.status === "completed") {
        group.completedCount += 1;
      }
      if (row.status === "retained") {
        group.retainedCount += 1;
      }
      if (row.retention_offer_accepted === "pause") {
        group.pausedCount += 1;
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

export const getCancellationFeedbackForAnalysis = internalQuery({
  args: {
    includeHistory: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    startAt: v.optional(v.number()),
    endAt: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      createdAt: v.string(),
      reasonCategory: v.union(reasonCategoryValidator, v.null()),
      reasonSubcategory: v.union(reasonSubcategoryValidator, v.null()),
      subscriptionTier: v.union(subscriptionTierValidator, v.null()),
      plan: v.union(v.string(), v.null()),
      status: v.union(
        v.literal("started"),
        v.literal("completed"),
        v.literal("retained"),
        v.null(),
      ),
      retentionOfferAccepted: v.union(
        v.literal("pause"),
        v.literal("downgrade"),
        v.null(),
      ),
      source: v.union(sourceValidator, v.null()),
      recentUsageSegment: v.union(usageSegmentValidator, v.null()),
      recentUsageRequestCount: v.union(v.number(), v.null()),
      recentUsageCostDollars: v.union(v.number(), v.null()),
      feedback: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const limit = Math.max(
      0,
      Math.min(
        args.limit ?? MAX_FEEDBACK_EXPORT_ROWS,
        MAX_FEEDBACK_EXPORT_ROWS,
      ),
    );

    const details = args.includeHistory
      ? await ctx.db
          .query("cancellation_reason_details")
          .withIndex("by_created_at", (q) => {
            if (args.startAt !== undefined && args.endAt !== undefined) {
              return q
                .gte("created_at", args.startAt)
                .lte("created_at", args.endAt);
            }
            if (args.startAt !== undefined) {
              return q.gte("created_at", args.startAt);
            }
            if (args.endAt !== undefined) {
              return q.lte("created_at", args.endAt);
            }
            return q;
          })
          .order("desc")
          .take(limit)
      : await ctx.db
          .query("current_cancellation_reasons")
          .withIndex("by_created_at", (q) => {
            if (args.startAt !== undefined && args.endAt !== undefined)
              return q
                .gte("created_at", args.startAt)
                .lte("created_at", args.endAt);
            if (args.startAt !== undefined)
              return q.gte("created_at", args.startAt);
            if (args.endAt !== undefined)
              return q.lte("created_at", args.endAt);
            return q;
          })
          .order("desc")
          .take(limit);

    return Promise.all(
      details.map(async (detail) => {
        const reason = await ctx.db.get(detail.cancellation_reason_id);

        return {
          createdAt: new Date(detail.created_at).toISOString(),
          reasonCategory: reason?.reason_category ?? null,
          reasonSubcategory: reason?.reason_subcategory ?? null,
          subscriptionTier: reason?.subscription_tier ?? null,
          plan: reason?.plan ?? null,
          status: reason?.status ?? null,
          retentionOfferAccepted: reason?.retention_offer_accepted ?? null,
          source: reason?.source ?? null,
          recentUsageSegment: reason?.recent_usage_segment ?? null,
          recentUsageRequestCount: reason?.recent_usage_request_count ?? null,
          recentUsageCostDollars: reason?.recent_usage_cost_dollars ?? null,
          feedback: detail.reason_details,
        };
      }),
    );
  },
});
