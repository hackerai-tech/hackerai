import { mutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { validateServiceKey } from "./lib/utils";

const MAX_DUE_RESUMES = 50;
const MAX_USER_PAUSE_ROWS = 20;
const MAX_SUBSCRIPTION_PAUSE_ROWS = 20;
/** A resume claim older than this is treated as abandoned and may be retried. */
const STALE_RESUME_CLAIM_MS = 15 * 60 * 1000;
const MAX_RESUME_ERROR_LENGTH = 500;

const subscriptionTierValidator = v.union(
  v.literal("free"),
  v.literal("pro"),
  v.literal("pro-plus"),
  v.literal("ultra"),
  v.literal("team"),
);

const pauseStatusValidator = v.union(
  v.literal("scheduled"),
  v.literal("paused"),
  v.literal("resuming"),
  v.literal("resumed"),
  v.literal("resume_failed"),
  v.literal("canceled"),
  v.literal("superseded"),
);

export const subscriptionPauseValidator = v.object({
  id: v.id("subscription_pauses"),
  userId: v.string(),
  organizationId: v.optional(v.string()),
  stripeCustomerId: v.string(),
  stripeSubscriptionId: v.string(),
  stripePriceId: v.string(),
  stripePriceLookupKey: v.optional(v.string()),
  subscriptionTier: v.optional(subscriptionTierValidator),
  quantity: v.number(),
  stripePaymentMethodId: v.optional(v.string()),
  reasonCategory: v.optional(v.string()),
  pauseMonths: v.number(),
  requestedAt: v.number(),
  pauseEffectiveAt: v.number(),
  resumeAt: v.number(),
  status: pauseStatusValidator,
  resumeAttemptCount: v.number(),
  lastResumeError: v.optional(v.string()),
  resumedAt: v.optional(v.number()),
  resumedStripeSubscriptionId: v.optional(v.string()),
});

export type SubscriptionPauseStatus = Doc<"subscription_pauses">["status"];

const ACTIVE_PAUSE_STATUSES: ReadonlySet<SubscriptionPauseStatus> = new Set([
  "scheduled",
  "paused",
  "resuming",
  "resume_failed",
]);

/** Statuses that still allow the subscription to be re-created. */
const RESUMABLE_PAUSE_STATUSES: ReadonlySet<SubscriptionPauseStatus> = new Set([
  "scheduled",
  "paused",
  "resume_failed",
]);

export function toSubscriptionPause(row: Doc<"subscription_pauses">) {
  return {
    id: row._id,
    userId: row.user_id,
    organizationId: row.organization_id,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    stripePriceId: row.stripe_price_id,
    stripePriceLookupKey: row.stripe_price_lookup_key,
    subscriptionTier: row.subscription_tier,
    quantity: row.quantity,
    stripePaymentMethodId: row.stripe_payment_method_id,
    reasonCategory: row.reason_category,
    pauseMonths: row.pause_months,
    requestedAt: row.requested_at,
    pauseEffectiveAt: row.pause_effective_at,
    resumeAt: row.resume_at,
    status: row.status,
    resumeAttemptCount: row.resume_attempt_count,
    lastResumeError: row.last_resume_error,
    resumedAt: row.resumed_at,
    resumedStripeSubscriptionId: row.resumed_stripe_subscription_id,
  };
}

async function latestPauseForUser(
  ctx: { db: QueryCtx["db"] },
  userId: string,
  predicate: (row: Doc<"subscription_pauses">) => boolean,
) {
  const rows = await ctx.db
    .query("subscription_pauses")
    .withIndex("by_user_requested", (q) => q.eq("user_id", userId))
    .order("desc")
    .take(MAX_USER_PAUSE_ROWS);
  return rows.find(predicate) ?? null;
}

function normalizeResumeError(error: string | undefined): string | undefined {
  const trimmed = error?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_RESUME_ERROR_LENGTH);
}

export const recordScheduledPause = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    organizationId: v.optional(v.string()),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    stripePriceId: v.string(),
    stripePriceLookupKey: v.optional(v.string()),
    subscriptionTier: v.optional(subscriptionTierValidator),
    quantity: v.number(),
    stripePaymentMethodId: v.optional(v.string()),
    reasonCategory: v.optional(v.string()),
    pauseMonths: v.number(),
    requestedAt: v.number(),
    pauseEffectiveAt: v.number(),
    resumeAt: v.number(),
  },
  returns: v.object({
    pauseId: v.id("subscription_pauses"),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const existing = await ctx.db
      .query("subscription_pauses")
      .withIndex("by_stripe_subscription_id", (q) =>
        q.eq("stripe_subscription_id", args.stripeSubscriptionId),
      )
      .order("desc")
      .take(MAX_SUBSCRIPTION_PAUSE_ROWS);
    const active = existing.find((row) =>
      ACTIVE_PAUSE_STATUSES.has(row.status),
    );
    if (active) {
      return { pauseId: active._id, created: false };
    }

    const pauseId = await ctx.db.insert("subscription_pauses", {
      user_id: args.userId,
      organization_id: args.organizationId,
      stripe_customer_id: args.stripeCustomerId,
      stripe_subscription_id: args.stripeSubscriptionId,
      stripe_price_id: args.stripePriceId,
      stripe_price_lookup_key: args.stripePriceLookupKey,
      subscription_tier: args.subscriptionTier,
      quantity: args.quantity,
      stripe_payment_method_id: args.stripePaymentMethodId,
      reason_category: args.reasonCategory,
      pause_months: args.pauseMonths,
      requested_at: args.requestedAt,
      pause_effective_at: args.pauseEffectiveAt,
      resume_at: args.resumeAt,
      status: "scheduled",
      resume_attempt_count: 0,
      updated_at: args.requestedAt,
    });

    return { pauseId, created: true };
  },
});

/** Called when the user keeps the plan before the pause takes effect. */
export const cancelScheduledPause = mutation({
  args: {
    serviceKey: v.string(),
    stripeSubscriptionId: v.string(),
    canceledAt: v.optional(v.number()),
  },
  returns: v.object({ canceledCount: v.number() }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const rows = await ctx.db
      .query("subscription_pauses")
      .withIndex("by_stripe_subscription_id", (q) =>
        q.eq("stripe_subscription_id", args.stripeSubscriptionId),
      )
      .take(MAX_SUBSCRIPTION_PAUSE_ROWS);
    const canceledAt = args.canceledAt ?? Date.now();
    let canceledCount = 0;
    for (const row of rows) {
      if (row.status !== "scheduled") continue;
      await ctx.db.patch(row._id, {
        status: "canceled",
        canceled_at: canceledAt,
        updated_at: canceledAt,
      });
      canceledCount += 1;
    }
    return { canceledCount };
  },
});

/** Called from the Stripe webhook once the paused subscription has ended. */
export const markPauseEffective = mutation({
  args: {
    serviceKey: v.string(),
    stripeSubscriptionId: v.string(),
    pausedAt: v.optional(v.number()),
  },
  returns: v.object({ updatedCount: v.number() }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const rows = await ctx.db
      .query("subscription_pauses")
      .withIndex("by_stripe_subscription_id", (q) =>
        q.eq("stripe_subscription_id", args.stripeSubscriptionId),
      )
      .take(MAX_SUBSCRIPTION_PAUSE_ROWS);
    const pausedAt = args.pausedAt ?? Date.now();
    let updatedCount = 0;
    for (const row of rows) {
      if (row.status !== "scheduled") continue;
      await ctx.db.patch(row._id, {
        status: "paused",
        paused_at: pausedAt,
        updated_at: pausedAt,
      });
      updatedCount += 1;
    }
    return { updatedCount };
  },
});

export const getLatestPauseForUser = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
  },
  returns: v.union(subscriptionPauseValidator, v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await latestPauseForUser(ctx, args.userId, () => true);
    return row ? toSubscriptionPause(row) : null;
  },
});

export const getActivePauseForUser = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
  },
  returns: v.union(subscriptionPauseValidator, v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await latestPauseForUser(ctx, args.userId, (candidate) =>
      ACTIVE_PAUSE_STATUSES.has(candidate.status),
    );
    return row ? toSubscriptionPause(row) : null;
  },
});

/** Authenticated read for the account settings UI. */
export const getMyActivePause = query({
  args: {},
  returns: v.union(subscriptionPauseValidator, v.null()),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const row = await latestPauseForUser(ctx, identity.subject, (candidate) =>
      ACTIVE_PAUSE_STATUSES.has(candidate.status),
    );
    return row ? toSubscriptionPause(row) : null;
  },
});

export const listDueResumes = query({
  args: {
    serviceKey: v.string(),
    now: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.array(subscriptionPauseValidator),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const limit = Math.max(1, Math.min(args.limit ?? MAX_DUE_RESUMES, 200));

    const due: Doc<"subscription_pauses">[] = [];
    for (const status of ["paused", "scheduled"] as const) {
      const rows = await ctx.db
        .query("subscription_pauses")
        .withIndex("by_status_resume_at", (q) =>
          q.eq("status", status).lte("resume_at", args.now),
        )
        .order("asc")
        .take(limit);
      due.push(...rows);
    }

    // Recover claims abandoned by a crashed worker.
    const staleClaims = await ctx.db
      .query("subscription_pauses")
      .withIndex("by_status_resume_at", (q) =>
        q.eq("status", "resuming").lte("resume_at", args.now),
      )
      .order("asc")
      .take(limit);
    for (const row of staleClaims) {
      if (
        row.resume_claimed_at !== undefined &&
        args.now - row.resume_claimed_at >= STALE_RESUME_CLAIM_MS
      ) {
        due.push(row);
      }
    }

    return due
      .sort((a, b) => a.resume_at - b.resume_at)
      .slice(0, limit)
      .map(toSubscriptionPause);
  },
});

/**
 * Atomically claim a pause for resumption. Returns null when another worker
 * already owns it or the pause is no longer resumable.
 */
export const claimResume = mutation({
  args: {
    serviceKey: v.string(),
    pauseId: v.id("subscription_pauses"),
    now: v.number(),
    /** User-initiated resumes ignore the automatic retry budget. */
    manual: v.optional(v.boolean()),
    maxAttempts: v.number(),
  },
  returns: v.union(subscriptionPauseValidator, v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const row = await ctx.db.get(args.pauseId);
    if (!row) return null;

    const staleClaim =
      row.status === "resuming" &&
      row.resume_claimed_at !== undefined &&
      args.now - row.resume_claimed_at >= STALE_RESUME_CLAIM_MS;
    if (!RESUMABLE_PAUSE_STATUSES.has(row.status) && !staleClaim) {
      return null;
    }
    if (
      !args.manual &&
      (row.status === "resume_failed" ||
        row.resume_attempt_count >= args.maxAttempts)
    ) {
      return null;
    }

    await ctx.db.patch(row._id, {
      status: "resuming",
      resume_claimed_at: args.now,
      last_resume_attempt_at: args.now,
      resume_attempt_count: row.resume_attempt_count + 1,
      updated_at: args.now,
    });

    const claimed = await ctx.db.get(row._id);
    return claimed ? toSubscriptionPause(claimed) : null;
  },
});

export const markResumeSucceeded = mutation({
  args: {
    serviceKey: v.string(),
    pauseId: v.id("subscription_pauses"),
    resumedStripeSubscriptionId: v.string(),
    resumedAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const resumedAt = args.resumedAt ?? Date.now();
    await ctx.db.patch(args.pauseId, {
      status: "resumed",
      resumed_at: resumedAt,
      resumed_stripe_subscription_id: args.resumedStripeSubscriptionId,
      last_resume_error: undefined,
      resume_claimed_at: undefined,
      updated_at: resumedAt,
    });
    return null;
  },
});

export const markResumeFailed = mutation({
  args: {
    serviceKey: v.string(),
    pauseId: v.id("subscription_pauses"),
    error: v.optional(v.string()),
    /** When set, the pause stays resumable and is retried at this time. */
    retryAt: v.optional(v.number()),
    failedAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const failedAt = args.failedAt ?? Date.now();
    await ctx.db.patch(args.pauseId, {
      status: args.retryAt === undefined ? "resume_failed" : "paused",
      ...(args.retryAt !== undefined && { resume_at: args.retryAt }),
      last_resume_error: normalizeResumeError(args.error),
      resume_claimed_at: undefined,
      updated_at: failedAt,
    });
    return null;
  },
});

/** The customer already has another live subscription; nothing to resume. */
export const markPauseSuperseded = mutation({
  args: {
    serviceKey: v.string(),
    pauseId: v.id("subscription_pauses"),
    stripeSubscriptionId: v.optional(v.string()),
    supersededAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const supersededAt = args.supersededAt ?? Date.now();
    await ctx.db.patch(args.pauseId, {
      status: "superseded",
      resumed_stripe_subscription_id: args.stripeSubscriptionId,
      resume_claimed_at: undefined,
      updated_at: supersededAt,
    });
    return null;
  },
});
