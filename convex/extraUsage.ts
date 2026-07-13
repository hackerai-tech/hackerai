import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";
import { convexLogger } from "./lib/logger";
import { recordRevenueEventInternal } from "./unitEconomicsLib";
import {
  extraUsageDollarsToPoints as dollarsToPoints,
  extraUsagePointsToDollars as pointsToDollars,
} from "./lib/extraUsagePricing";
import { validateMonthlyCapDollars } from "./lib/extraUsageValidation";

type ExtraUsagePurchaseStatus = "created" | "paid_seen" | "credited" | "failed";
type ExtraUsagePurchaseRoute =
  "checkout_action" | "confirm" | "webhook" | "repair";
type ExtraUsagePurchaseResult =
  "created" | "paid_seen" | "credited" | "already_processed" | "failed";
type MaxModelExtraUsageReason =
  "available" | "disabled" | "empty" | "monthly_cap_exhausted";

const MAX_PURCHASE_ERROR_LENGTH = 500;
const AUTO_RELOAD_RETRY_COOLDOWN_MS = 15_000;
const AUTO_RELOAD_OPERATION_LEASE_MS = 2 * 60_000;
const PURCHASE_JSON_SECRET_PATTERN =
  /(["'])(serviceKey|service_key|apiKey|api_key|authorization|cookie|password|secret|token)\1\s*:\s*(["'])(?:(?!\3).)*\3/gi;
const PURCHASE_ASSIGNMENT_SECRET_PATTERN =
  /\b(serviceKey|service_key|apiKey|api_key|cookie|password|secret|token)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,}]+)/gi;
const PURCHASE_AUTHORIZATION_BEARER_PATTERN =
  /\bAuthorization\s*[:=]\s*Bearer\s+[^\s,}]+/gi;
const PURCHASE_BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

const sanitizePurchaseError = (error: string): string =>
  error
    .replace(
      PURCHASE_AUTHORIZATION_BEARER_PATTERN,
      "Authorization: Bearer [redacted]",
    )
    .replace(PURCHASE_JSON_SECRET_PATTERN, (_match, quote, key) => {
      return `${quote}${key}${quote}: "[redacted]"`;
    })
    .replace(PURCHASE_BEARER_TOKEN_PATTERN, "Bearer [redacted]")
    .replace(PURCHASE_ASSIGNMENT_SECRET_PATTERN, (match) => {
      const separatorIndex = Math.max(match.indexOf(":"), match.indexOf("="));
      if (separatorIndex === -1) return "[redacted]";
      return `${match.slice(0, separatorIndex + 1)} [redacted]`;
    })
    .split("\n", 1)[0]
    .trim()
    .slice(0, MAX_PURCHASE_ERROR_LENGTH);

const currentMonthString = (): string => {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
};

const getMonthlySpentPointsForCurrentMonth = (
  settings: Doc<"extra_usage"> | null,
): number => {
  if (!settings || settings.monthly_reset_date !== currentMonthString()) {
    return 0;
  }
  return settings.monthly_spent_points ?? 0;
};

type AutoReloadChargeEvaluation =
  { allowed: true; amountCents: number } | { allowed: false; reason: string };

/**
 * Evaluate an auto-reload from one transactional wallet snapshot.
 *
 * Keeping this calculation shared by new and resumed operations prevents an
 * old invoice from bypassing a later balance, configuration, or cap change.
 */
const evaluateAutoReloadCharge = ({
  balancePoints,
  thresholdPoints,
  reloadAmountDollars,
  requestedAmountPoints,
  monthlyRemainingPoints,
}: {
  balancePoints: number;
  thresholdPoints: number;
  reloadAmountDollars: number;
  requestedAmountPoints: number;
  monthlyRemainingPoints?: number;
}): AutoReloadChargeEvaluation => {
  if (reloadAmountDollars <= 0) {
    return { allowed: false, reason: "reload_amount_not_configured" };
  }

  if (
    requestedAmountPoints > 0
      ? balancePoints >= requestedAmountPoints
      : balancePoints > thresholdPoints
  ) {
    return { allowed: false, reason: "not_needed" };
  }

  if (
    monthlyRemainingPoints !== undefined &&
    requestedAmountPoints > monthlyRemainingPoints
  ) {
    return { allowed: false, reason: "monthly_cap_exceeded" };
  }

  const targetBalancePoints = Math.max(
    dollarsToPoints(reloadAmountDollars),
    requestedAmountPoints,
  );
  const desiredTopUpPoints = Math.max(0, targetBalancePoints - balancePoints);
  const capHeadroomPoints =
    monthlyRemainingPoints === undefined
      ? undefined
      : Math.max(0, monthlyRemainingPoints - balancePoints);
  const desiredCents = Math.ceil(
    Number((pointsToDollars(desiredTopUpPoints) * 100).toFixed(6)),
  );
  const desiredChargeCents =
    requestedAmountPoints > 0 && desiredCents > 0
      ? Math.max(100, desiredCents)
      : desiredCents;
  let maxAllowedCents = desiredChargeCents;
  if (capHeadroomPoints !== undefined) {
    maxAllowedCents = Math.ceil(
      Number((pointsToDollars(capHeadroomPoints) * 100).toFixed(6)),
    );
    while (
      maxAllowedCents > 0 &&
      dollarsToPoints(maxAllowedCents / 100) > capHeadroomPoints
    ) {
      maxAllowedCents--;
    }
  }

  const amountCents = Math.min(desiredChargeCents, maxAllowedCents);
  const creditedPoints = dollarsToPoints(amountCents / 100);
  if (
    amountCents < 100 ||
    (requestedAmountPoints > 0 &&
      balancePoints + creditedPoints < requestedAmountPoints)
  ) {
    return { allowed: false, reason: "amount_to_charge_below_minimum" };
  }

  return { allowed: true, amountCents };
};

async function upsertExtraUsagePurchase(
  ctx: MutationCtx,
  args: {
    userId: string;
    amountDollars: number;
    stripeCheckoutSessionId: string;
    stripePaymentIntentId?: string;
    stripeInvoiceId?: string;
    status: ExtraUsagePurchaseStatus;
    route: ExtraUsagePurchaseRoute;
    result: ExtraUsagePurchaseResult;
    lastError?: string | null;
    creditedAt?: number;
  },
) {
  const now = Date.now();
  const existing = await ctx.db
    .query("extra_usage_purchases")
    .withIndex("by_stripe_checkout_session_id", (q) =>
      q.eq("stripe_checkout_session_id", args.stripeCheckoutSessionId),
    )
    .unique();

  const keepCredited =
    existing?.status === "credited" && args.status !== "credited";
  const next: Record<string, unknown> = {
    user_id: args.userId,
    amount_dollars: args.amountDollars,
    stripe_checkout_session_id: args.stripeCheckoutSessionId,
    stripe_payment_intent_id:
      args.stripePaymentIntentId ?? existing?.stripe_payment_intent_id,
    stripe_invoice_id: args.stripeInvoiceId ?? existing?.stripe_invoice_id,
    status: keepCredited ? "credited" : args.status,
    last_route: keepCredited ? existing?.last_route : args.route,
    last_result: keepCredited ? existing?.last_result : args.result,
    updated_at: now,
  };

  if (!keepCredited) {
    if (args.lastError !== undefined) {
      next.last_error =
        args.lastError === null
          ? undefined
          : sanitizePurchaseError(args.lastError);
    } else if (args.status !== "failed") {
      next.last_error = undefined;
    }
  }

  if (args.status === "credited") {
    next.credited_at = existing?.credited_at ?? args.creditedAt ?? now;
  }

  if (existing) {
    await ctx.db.patch(existing._id, next);
    return existing._id;
  }

  return await ctx.db.insert("extra_usage_purchases", {
    ...next,
    created_at: now,
  } as any);
}

// =============================================================================
// Webhook Idempotency
// =============================================================================

/**
 * Internal mutation: purge processed_webhooks rows older than cutoff.
 * Stripe only retries within ~72h, so retention of a week is plenty.
 * Iterates oldest-first via the implicit by_creation_time ordering.
 */
export const purgeOldProcessedWebhooks = internalMutation({
  args: {
    cutoffTimeMs: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.object({ deletedCount: v.number() }),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;

    const rows = await ctx.db
      .query("processed_webhooks")
      .order("asc")
      .take(limit);

    let deletedCount = 0;
    for (const row of rows) {
      if (row.processed_at < args.cutoffTimeMs) {
        await ctx.db.delete(row._id);
        deletedCount++;
      }
    }
    return { deletedCount };
  },
});

/**
 * Check-and-mark a webhook event as processed (idempotency guard).
 * Returns { alreadyProcessed: true } if the event was already recorded.
 * Pass checkOnly: true to only check without marking (mark after successful processing).
 */
export const checkAndMarkWebhook = mutation({
  args: {
    serviceKey: v.string(),
    eventId: v.string(),
    checkOnly: v.optional(v.boolean()),
  },
  returns: v.object({
    alreadyProcessed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    // .unique() throws if duplicates exist, surfacing any state-machine
    // invariant break instead of silently masking it.
    const existing = await ctx.db
      .query("processed_webhooks")
      .withIndex("by_event_id", (q) => q.eq("event_id", args.eventId))
      .unique();

    if (existing) {
      return { alreadyProcessed: true };
    }

    if (!args.checkOnly) {
      await ctx.db.insert("processed_webhooks", {
        event_id: args.eventId,
        processed_at: Date.now(),
        status: "completed",
      });
    }

    return { alreadyProcessed: false };
  },
});

/**
 * How long a `pending` claim is honored before it can be taken over by a
 * retrying delivery. Sized larger than any reasonable handler runtime so a
 * still-running first attempt is not pre-empted, but small enough that a
 * crashed first attempt unblocks the next Stripe webhook retry within the
 * same retry window (Stripe backs off exponentially over hours).
 */
const STALE_CLAIM_MS = 10 * 60 * 1000;

/**
 * Atomic claim for webhook processing.
 *
 * Replaces the read-then-write `checkAndMarkWebhook(checkOnly: true)` pattern,
 * which was a TOCTOU pair: two concurrent deliveries of the same event could
 * both pass the pre-check and both run side effects before either landed the
 * mark.
 *
 * Returns one of three states atomically:
 *   - "acquired"          : caller now owns the claim; run handler then call
 *                           finalizeWebhookProcessing on success
 *   - "already_processed" : event was finalized previously; skip with 200
 *   - "claim_held"        : another worker is currently processing this event;
 *                           skip with 200 (the holder will finalize, or its
 *                           claim will expire and a future retry takes over)
 *
 * If a `pending` row's claim is older than STALE_CLAIM_MS, this mutation
 * reclaims it and returns "acquired" — this is what allows Stripe webhook
 * retries to recover after a handler crash.
 */
export const claimWebhookProcessing = mutation({
  args: {
    serviceKey: v.string(),
    eventId: v.string(),
  },
  returns: v.object({
    state: v.union(
      v.literal("acquired"),
      v.literal("already_processed"),
      v.literal("claim_held"),
    ),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const now = Date.now();
    // .unique() throws if duplicates exist, surfacing any state-machine
    // invariant break instead of silently masking it.
    const existing = await ctx.db
      .query("processed_webhooks")
      .withIndex("by_event_id", (q) => q.eq("event_id", args.eventId))
      .unique();

    if (!existing) {
      await ctx.db.insert("processed_webhooks", {
        event_id: args.eventId,
        processed_at: now,
        status: "pending",
        claimed_at: now,
      });
      return { state: "acquired" as const };
    }

    // Legacy rows without status were inserted under the older "mark on entry"
    // semantics for events whose lifecycle has already concluded.
    const status = existing.status ?? "completed";

    if (status === "completed") {
      return { state: "already_processed" as const };
    }

    const claimedAt = existing.claimed_at ?? existing.processed_at;
    if (now - claimedAt < STALE_CLAIM_MS) {
      return { state: "claim_held" as const };
    }

    // Stale claim — take it over so Stripe's retry can drive completion.
    await ctx.db.patch(existing._id, {
      status: "pending",
      claimed_at: now,
    });
    return { state: "acquired" as const };
  },
});

/**
 * Mark a previously-claimed webhook as completed.
 *
 * Idempotent: re-finalizing an already-completed event is a no-op. Missing
 * rows are also tolerated (the row should always exist when called immediately
 * after a successful claim, but we don't fail the request if it doesn't).
 */
export const finalizeWebhookProcessing = mutation({
  args: {
    serviceKey: v.string(),
    eventId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    // .unique() throws if duplicates exist, surfacing any state-machine
    // invariant break instead of silently masking it.
    const existing = await ctx.db
      .query("processed_webhooks")
      .withIndex("by_event_id", (q) => q.eq("event_id", args.eventId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        status: "completed",
        processed_at: Date.now(),
      });
    }
    return null;
  },
});

// =============================================================================
// Balance Management (Mutations)
// =============================================================================

/**
 * Record the Stripe Checkout session as soon as it is created. Internal because
 * authenticated Convex actions are the only callers at creation time.
 */
export const recordPurchaseCreated = internalMutation({
  args: {
    userId: v.string(),
    amountDollars: v.number(),
    stripeCheckoutSessionId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await upsertExtraUsagePurchase(ctx, {
      userId: args.userId,
      amountDollars: args.amountDollars,
      stripeCheckoutSessionId: args.stripeCheckoutSessionId,
      status: "created",
      route: "checkout_action",
      result: "created",
      lastError: null,
    });
    return null;
  },
});

/**
 * Mark that a trusted Stripe route observed payment_status=paid before the
 * actual balance-credit mutation runs.
 */
export const recordPurchasePaidSeen = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    amountDollars: v.number(),
    stripeCheckoutSessionId: v.string(),
    stripePaymentIntentId: v.optional(v.string()),
    stripeInvoiceId: v.optional(v.string()),
    route: v.union(
      v.literal("confirm"),
      v.literal("webhook"),
      v.literal("repair"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    await upsertExtraUsagePurchase(ctx, {
      userId: args.userId,
      amountDollars: args.amountDollars,
      stripeCheckoutSessionId: args.stripeCheckoutSessionId,
      stripePaymentIntentId: args.stripePaymentIntentId,
      stripeInvoiceId: args.stripeInvoiceId,
      status: "paid_seen",
      route: args.route,
      result: "paid_seen",
      lastError: null,
    });
    return null;
  },
});

/**
 * Persist credit failures separately from addCredits so thrown transaction
 * failures do not erase the support trail.
 */
export const recordPurchaseFailed = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    amountDollars: v.number(),
    stripeCheckoutSessionId: v.string(),
    stripePaymentIntentId: v.optional(v.string()),
    stripeInvoiceId: v.optional(v.string()),
    route: v.union(
      v.literal("confirm"),
      v.literal("webhook"),
      v.literal("repair"),
    ),
    lastError: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    await upsertExtraUsagePurchase(ctx, {
      userId: args.userId,
      amountDollars: args.amountDollars,
      stripeCheckoutSessionId: args.stripeCheckoutSessionId,
      stripePaymentIntentId: args.stripePaymentIntentId,
      stripeInvoiceId: args.stripeInvoiceId,
      status: "failed",
      route: args.route,
      result: "failed",
      lastError: args.lastError,
    });
    return null;
  },
});

/**
 * Add credits to user balance (after successful Stripe payment).
 * Idempotent via optional idempotencyKey (Stripe event ID).
 */
export const addCredits = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    amountDollars: v.number(),
    idempotencyKey: v.optional(v.string()), // Primary dedup key (session-scoped: `cs_<id>`)
    legacyIdempotencyKey: v.optional(v.string()), // Stripe event ID — checked only to guard pre-deploy webhook retries
    revenueSource: v.optional(
      v.union(
        v.literal("extra_usage_purchase"),
        v.literal("extra_usage_auto_reload"),
      ),
    ),
    stripeCustomerId: v.optional(v.string()),
    stripeCheckoutSessionId: v.optional(v.string()),
    stripePaymentIntentId: v.optional(v.string()),
    stripeInvoiceId: v.optional(v.string()),
    purchaseRoute: v.optional(
      v.union(v.literal("confirm"), v.literal("webhook"), v.literal("repair")),
    ),
  },
  returns: v.object({
    newBalance: v.number(), // Returns dollars
    alreadyProcessed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const markPurchaseCredited = async (creditedAt?: number) => {
      if (!args.stripeCheckoutSessionId) return;

      await upsertExtraUsagePurchase(ctx, {
        userId: args.userId,
        amountDollars: args.amountDollars,
        stripeCheckoutSessionId: args.stripeCheckoutSessionId,
        stripePaymentIntentId: args.stripePaymentIntentId,
        stripeInvoiceId: args.stripeInvoiceId,
        status: "credited",
        route: args.purchaseRoute ?? "repair",
        result: "credited",
        lastError: null,
        creditedAt,
      });
    };

    const markPurchaseAlreadyProcessed = async () => {
      if (!args.stripeCheckoutSessionId) return;

      await upsertExtraUsagePurchase(ctx, {
        userId: args.userId,
        amountDollars: args.amountDollars,
        stripeCheckoutSessionId: args.stripeCheckoutSessionId,
        stripePaymentIntentId: args.stripePaymentIntentId,
        stripeInvoiceId: args.stripeInvoiceId,
        status: "paid_seen",
        route: args.purchaseRoute ?? "repair",
        result: "already_processed",
        lastError: null,
      });
    };

    // Idempotency: skip if already processed (prevents double-credit on webhook retries
    // and across both the post-checkout confirm path and the async webhook path)
    const sessionKey = args.idempotencyKey;
    if (sessionKey) {
      const durableExisting = await ctx.db
        .query("processed_checkout_sessions")
        .withIndex("by_session_key", (q) => q.eq("session_key", sessionKey))
        .unique();
      if (durableExisting) {
        await markPurchaseCredited(durableExisting.processed_at);
        return { newBalance: 0, alreadyProcessed: true };
      }
    }

    const dedupKeys = [args.idempotencyKey, args.legacyIdempotencyKey].filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );
    for (const key of dedupKeys) {
      const existing = await ctx.db
        .query("processed_webhooks")
        .withIndex("by_event_id", (q) => q.eq("event_id", key))
        .first();

      if (existing) {
        if (key === args.idempotencyKey) {
          await markPurchaseCredited(existing.processed_at);
        } else {
          // A legacy evt_* row only proves another webhook endpoint saw this
          // Stripe event; it does not prove the Checkout Session was credited.
          await markPurchaseAlreadyProcessed();
        }
        return { newBalance: 0, alreadyProcessed: true };
      }
    }

    // Validate amount
    if (isNaN(args.amountDollars) || args.amountDollars <= 0) {
      throw new Error("Invalid amount: must be a positive number");
    }

    const amountPoints = dollarsToPoints(args.amountDollars);

    // Get current settings
    const settings = await ctx.db
      .query("extra_usage")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .first();

    const currentBalancePoints = settings?.balance_points ?? 0;
    const newBalancePoints = currentBalancePoints + amountPoints;

    // Update or create settings
    const now = Date.now();
    if (settings) {
      await ctx.db.patch(settings._id, {
        balance_points: newBalancePoints,
        updated_at: now,
      });
    } else {
      await ctx.db.insert("extra_usage", {
        user_id: args.userId,
        balance_points: newBalancePoints,
        updated_at: now,
      });
    }

    // Mark processed after success (so retries work if above fails)
    if (args.idempotencyKey) {
      await ctx.db.insert("processed_checkout_sessions", {
        session_key: args.idempotencyKey,
        processed_at: Date.now(),
      });
      await ctx.db.insert("processed_webhooks", {
        event_id: args.idempotencyKey,
        processed_at: Date.now(),
      });
    }

    await recordRevenueEventInternal(ctx, {
      entityType: "user",
      entityId: args.userId,
      userId: args.userId,
      source: "extra_usage",
      sourceEventId:
        args.stripeCheckoutSessionId ??
        args.stripePaymentIntentId ??
        args.idempotencyKey ??
        `extra_usage:${args.userId}:${Date.now()}`,
      idempotencyKey:
        args.idempotencyKey ??
        args.stripePaymentIntentId ??
        args.stripeCheckoutSessionId,
      grossRevenueDollars: args.amountDollars,
      currency: "usd",
      attributionStrategy: "direct",
      stripeCustomerId: args.stripeCustomerId,
      stripeInvoiceId: args.stripeInvoiceId,
      stripeCheckoutSessionId: args.stripeCheckoutSessionId,
      stripePaymentIntentId: args.stripePaymentIntentId,
      description: args.revenueSource ?? "extra_usage_purchase",
    });

    await markPurchaseCredited();

    convexLogger.info("credits_added", {
      user_id: args.userId,
      amount_dollars: args.amountDollars,
      amount_points: amountPoints,
      new_balance_points: newBalancePoints,
      new_balance_dollars: pointsToDollars(newBalancePoints),
      idempotency_key: args.idempotencyKey,
      stripe_checkout_session_id: args.stripeCheckoutSessionId,
      stripe_payment_intent_id: args.stripePaymentIntentId,
      stripe_invoice_id: args.stripeInvoiceId,
      purchase_route: args.purchaseRoute,
    });

    return {
      newBalance: pointsToDollars(newBalancePoints),
      alreadyProcessed: false,
    };
  },
});

/**
 * Deduct points from user balance for usage (points-based API).
 * Accepts points directly, avoiding precision loss from dollar conversion.
 * Used by the rate limiting system which operates in points.
 */
export const deductPoints = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    amountPoints: v.number(),
    usageSettlementId: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    newBalancePoints: v.number(),
    newBalanceDollars: v.number(),
    insufficientFunds: v.boolean(),
    monthlyCapExceeded: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    // Get current settings
    const settings = await ctx.db
      .query("extra_usage")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .first();

    if (!settings) {
      convexLogger.warn("deduct_points_failed", {
        user_id: args.userId,
        amount_points: args.amountPoints,
        usage_settlement_id: args.usageSettlementId,
        reason: "no_settings",
        insufficient_funds: true,
      });
      return {
        success: false,
        newBalancePoints: 0,
        newBalanceDollars: 0,
        insufficientFunds: true,
        monthlyCapExceeded: false,
      };
    }

    const currentBalancePoints = settings.balance_points ?? 0;

    // Check if user has enough balance
    if (currentBalancePoints < args.amountPoints) {
      convexLogger.warn("deduct_points_failed", {
        user_id: args.userId,
        amount_points: args.amountPoints,
        usage_settlement_id: args.usageSettlementId,
        current_balance_points: currentBalancePoints,
        reason: "insufficient_balance",
        insufficient_funds: true,
      });
      return {
        success: false,
        newBalancePoints: currentBalancePoints,
        newBalanceDollars: pointsToDollars(currentBalancePoints),
        insufficientFunds: true,
        monthlyCapExceeded: false,
      };
    }

    // Calculate current month for tracking
    const now = new Date();
    const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

    // Reset monthly spending if month changed
    let monthlySpentPoints = settings.monthly_spent_points ?? 0;
    const shouldResetMonthly = settings.monthly_reset_date !== currentMonth;
    if (shouldResetMonthly) {
      monthlySpentPoints = 0;
    }

    // Check monthly spending cap before deducting
    const monthlyCapPoints = settings.monthly_cap_points;
    if (monthlyCapPoints !== undefined) {
      const newMonthlySpent = monthlySpentPoints + args.amountPoints;
      if (newMonthlySpent > monthlyCapPoints) {
        convexLogger.warn("deduct_points_failed", {
          user_id: args.userId,
          amount_points: args.amountPoints,
          usage_settlement_id: args.usageSettlementId,
          monthly_spent_points: monthlySpentPoints,
          monthly_cap_points: monthlyCapPoints,
          reason: "monthly_cap_exceeded",
          monthly_cap_exceeded: true,
        });
        return {
          success: false,
          newBalancePoints: currentBalancePoints,
          newBalanceDollars: pointsToDollars(currentBalancePoints),
          insufficientFunds: true,
          monthlyCapExceeded: true,
        };
      }
    }

    // Add to monthly spending
    monthlySpentPoints += args.amountPoints;

    // Deduct balance and update monthly tracking
    const newBalancePoints = currentBalancePoints - args.amountPoints;
    await ctx.db.patch(settings._id, {
      balance_points: newBalancePoints,
      monthly_spent_points: monthlySpentPoints,
      monthly_reset_date: currentMonth,
      updated_at: Date.now(),
    });

    convexLogger.info("points_deducted", {
      user_id: args.userId,
      amount_points: args.amountPoints,
      usage_settlement_id: args.usageSettlementId,
      previous_balance_points: currentBalancePoints,
      new_balance_points: newBalancePoints,
      monthly_spent_points: monthlySpentPoints,
      monthly_cap_points: monthlyCapPoints,
    });

    return {
      success: true,
      newBalancePoints,
      newBalanceDollars: pointsToDollars(newBalancePoints),
      insufficientFunds: false,
      monthlyCapExceeded: false,
    };
  },
});

/**
 * Atomically coalesce parallel auto-reload attempts for one user.
 *
 * The returned operation id is also the root Stripe idempotency key. A caller
 * that finds an existing operation must resume that operation rather than
 * creating a second invoice from another low-balance snapshot.
 */
export const claimAutoReloadOperation = internalMutation({
  args: {
    userId: v.string(),
    candidateOperationId: v.string(),
    candidateExecutorId: v.string(),
    requestedAmountPoints: v.number(),
  },
  returns: v.object({
    status: v.union(
      v.literal("operation"),
      v.literal("not_needed"),
      v.literal("blocked"),
      v.literal("cooldown"),
    ),
    operationId: v.optional(v.string()),
    amountDollars: v.optional(v.number()),
    stripeInvoiceId: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    executorId: v.optional(v.string()),
    claimed: v.optional(v.boolean()),
    paymentAllowed: v.optional(v.boolean()),
    paymentBlockedReason: v.optional(v.string()),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const settings = await ctx.db
      .query("extra_usage")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .first();

    const now = Date.now();
    const requestedAmountPoints = Math.max(
      0,
      Math.round(args.requestedAmountPoints),
    );
    const monthlySpentPoints = getMonthlySpentPointsForCurrentMonth(settings);
    const monthlyCapPoints = settings?.monthly_cap_points;
    const monthlyRemainingPoints =
      monthlyCapPoints === undefined
        ? undefined
        : Math.max(0, monthlyCapPoints - monthlySpentPoints);
    if (
      settings?.auto_reload_operation_id &&
      settings.auto_reload_operation_amount_dollars !== undefined
    ) {
      const leaseExpired =
        (settings.auto_reload_operation_lease_expires_at ?? 0) <= now;
      if (leaseExpired) {
        await ctx.db.patch(settings._id, {
          auto_reload_operation_executor_id: args.candidateExecutorId,
          auto_reload_operation_lease_expires_at:
            now + AUTO_RELOAD_OPERATION_LEASE_MS,
          updated_at: now,
        });
      }
      const evaluation = settings.auto_reload_enabled
        ? evaluateAutoReloadCharge({
            balancePoints: settings.balance_points ?? 0,
            thresholdPoints: settings.auto_reload_threshold_points ?? 0,
            reloadAmountDollars: settings.auto_reload_amount_dollars ?? 0,
            requestedAmountPoints,
            monthlyRemainingPoints,
          })
        : ({ allowed: false, reason: "auto_reload_disabled" } as const);
      const operationAmountCents = Math.round(
        settings.auto_reload_operation_amount_dollars * 100,
      );
      const balancePoints = settings.balance_points ?? 0;
      const operationBalancePoints =
        balancePoints +
        dollarsToPoints(settings.auto_reload_operation_amount_dollars);
      const operationSatisfiesNeed =
        requestedAmountPoints > 0
          ? operationBalancePoints >= requestedAmountPoints
          : operationBalancePoints >
            (settings.auto_reload_threshold_points ?? 0);
      const paymentAllowed =
        evaluation.allowed &&
        operationAmountCents <= evaluation.amountCents &&
        operationSatisfiesNeed;
      const paymentBlockedReason = !evaluation.allowed
        ? evaluation.reason
        : operationAmountCents > evaluation.amountCents
          ? "reload_amount_changed"
          : !operationSatisfiesNeed
            ? "reload_amount_insufficient"
            : undefined;
      return {
        status: "operation" as const,
        operationId: settings.auto_reload_operation_id,
        amountDollars: settings.auto_reload_operation_amount_dollars,
        stripeInvoiceId: settings.auto_reload_operation_stripe_invoice_id,
        startedAt: settings.auto_reload_operation_started_at,
        executorId: leaseExpired ? args.candidateExecutorId : undefined,
        claimed: leaseExpired,
        paymentAllowed,
        paymentBlockedReason,
      };
    }

    if (!settings || !(settings.auto_reload_enabled ?? false)) {
      return { status: "blocked" as const, reason: "auto_reload_disabled" };
    }

    if ((settings.auto_reload_retry_after ?? 0) > now) {
      return {
        status: "cooldown" as const,
        reason: settings.auto_reload_last_failure_reason ?? "payment_failed",
      };
    }

    const balancePoints = settings.balance_points ?? 0;
    const thresholdPoints = settings.auto_reload_threshold_points ?? 0;
    const reloadAmountDollars = settings.auto_reload_amount_dollars ?? 0;
    const evaluation = evaluateAutoReloadCharge({
      balancePoints,
      thresholdPoints,
      reloadAmountDollars,
      requestedAmountPoints,
      monthlyRemainingPoints,
    });
    if (!evaluation.allowed) {
      return {
        status:
          evaluation.reason === "not_needed"
            ? ("not_needed" as const)
            : ("blocked" as const),
        reason: evaluation.reason,
      };
    }

    const amountCents = evaluation.amountCents;
    const amountDollars = amountCents / 100;
    await ctx.db.patch(settings._id, {
      auto_reload_operation_id: args.candidateOperationId,
      auto_reload_operation_executor_id: args.candidateExecutorId,
      auto_reload_operation_started_at: now,
      auto_reload_operation_lease_expires_at:
        now + AUTO_RELOAD_OPERATION_LEASE_MS,
      auto_reload_operation_amount_dollars: amountDollars,
      auto_reload_operation_stripe_invoice_id: undefined,
      updated_at: now,
    });

    return {
      status: "operation" as const,
      operationId: args.candidateOperationId,
      amountDollars,
      startedAt: now,
      executorId: args.candidateExecutorId,
      claimed: true,
      paymentAllowed: true,
    };
  },
});

export const recordAutoReloadInvoice = internalMutation({
  args: {
    userId: v.string(),
    operationId: v.string(),
    executorId: v.string(),
    stripeInvoiceId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const settings = await ctx.db
      .query("extra_usage")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .first();
    if (
      !settings ||
      settings.auto_reload_operation_id !== args.operationId ||
      settings.auto_reload_operation_executor_id !== args.executorId
    ) {
      return false;
    }
    await ctx.db.patch(settings._id, {
      auto_reload_operation_stripe_invoice_id: args.stripeInvoiceId,
      updated_at: Date.now(),
    });
    return true;
  },
});

export const completeAutoReloadOperation = internalMutation({
  args: {
    userId: v.string(),
    operationId: v.string(),
    executorId: v.string(),
    outcome: v.union(
      v.literal("success"),
      v.literal("released"),
      v.literal("executor_released"),
      v.literal("definitive_failure"),
    ),
    failureReason: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const settings = await ctx.db
      .query("extra_usage")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .first();
    if (
      !settings ||
      settings.auto_reload_operation_id !== args.operationId ||
      settings.auto_reload_operation_executor_id !== args.executorId
    ) {
      return false;
    }

    const now = Date.now();
    if (args.outcome === "executor_released") {
      await ctx.db.patch(settings._id, {
        auto_reload_operation_executor_id: undefined,
        auto_reload_operation_lease_expires_at: 0,
        updated_at: now,
      });
      return true;
    }

    await ctx.db.patch(settings._id, {
      auto_reload_operation_id: undefined,
      auto_reload_operation_executor_id: undefined,
      auto_reload_operation_started_at: undefined,
      auto_reload_operation_lease_expires_at: undefined,
      auto_reload_operation_amount_dollars: undefined,
      auto_reload_operation_stripe_invoice_id: undefined,
      ...(args.outcome === "success"
        ? {
            auto_reload_retry_after: undefined,
            auto_reload_last_failure_reason: undefined,
          }
        : args.outcome === "definitive_failure"
          ? {
              auto_reload_retry_after: now + AUTO_RELOAD_RETRY_COOLDOWN_MS,
              auto_reload_last_failure_reason:
                args.failureReason ?? "payment_failed",
            }
          : {}),
      updated_at: now,
    });
    return true;
  },
});

/**
 * Refund points to user balance (for failed requests).
 * This is the reverse of deductPoints - adds points back to the balance.
 * Does NOT affect monthly spending tracking (refunds don't reduce spent amount).
 */
export const refundPoints = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    amountPoints: v.number(),
  },
  returns: v.object({
    success: v.boolean(),
    newBalancePoints: v.number(),
    newBalanceDollars: v.number(),
    noOp: v.optional(v.boolean()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    // No-op: nothing to refund
    if (args.amountPoints <= 0) {
      return {
        success: true,
        newBalancePoints: 0,
        newBalanceDollars: 0,
        noOp: true,
      };
    }

    // Get current settings
    const settings = await ctx.db
      .query("extra_usage")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .first();

    if (!settings) {
      // No settings record means no balance to refund to - create one
      await ctx.db.insert("extra_usage", {
        user_id: args.userId,
        balance_points: args.amountPoints,
        updated_at: Date.now(),
      });

      convexLogger.info("points_refunded", {
        user_id: args.userId,
        amount_points: args.amountPoints,
        previous_balance_points: 0,
        new_balance_points: args.amountPoints,
        created_new_record: true,
      });

      return {
        success: true,
        newBalancePoints: args.amountPoints,
        newBalanceDollars: pointsToDollars(args.amountPoints),
      };
    }

    const currentBalancePoints = settings.balance_points ?? 0;
    const newBalancePoints = currentBalancePoints + args.amountPoints;

    await ctx.db.patch(settings._id, {
      balance_points: newBalancePoints,
      updated_at: Date.now(),
    });

    convexLogger.info("points_refunded", {
      user_id: args.userId,
      amount_points: args.amountPoints,
      previous_balance_points: currentBalancePoints,
      new_balance_points: newBalancePoints,
    });

    return {
      success: true,
      newBalancePoints,
      newBalanceDollars: pointsToDollars(newBalancePoints),
    };
  },
});

// =============================================================================
// Queries
// =============================================================================

/**
 * Get user's extra usage balance and settings (for backend).
 * Returns balance in both dollars and points for flexibility.
 */
export const getExtraUsageBalanceForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
  },
  returns: v.object({
    balanceDollars: v.number(),
    balancePoints: v.number(),
    enabled: v.boolean(),
    autoReloadEnabled: v.boolean(),
    autoReloadThresholdDollars: v.optional(v.number()),
    autoReloadThresholdPoints: v.optional(v.number()),
    autoReloadAmountDollars: v.optional(v.number()),
    autoReloadOperationPending: v.boolean(),
    monthlyCapDollars: v.optional(v.number()),
    monthlySpentDollars: v.number(),
    monthlyRemainingDollars: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    // Get enabled flag from user_customization
    const customization = await ctx.db
      .query("user_customization")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .first();

    // Get balance and settings from extra_usage
    const settings = await ctx.db
      .query("extra_usage")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .first();

    const balancePoints = settings?.balance_points ?? 0;
    const thresholdPoints = settings?.auto_reload_threshold_points;
    const monthlySpentPoints = getMonthlySpentPointsForCurrentMonth(settings);
    const monthlyCapPoints = settings?.monthly_cap_points;
    const monthlyRemainingPoints =
      monthlyCapPoints === undefined
        ? undefined
        : Math.max(0, monthlyCapPoints - monthlySpentPoints);

    return {
      balanceDollars: pointsToDollars(balancePoints),
      balancePoints,
      enabled: customization?.extra_usage_enabled ?? false,
      autoReloadEnabled: settings?.auto_reload_enabled ?? false,
      autoReloadThresholdDollars: thresholdPoints
        ? pointsToDollars(thresholdPoints)
        : undefined,
      autoReloadThresholdPoints: thresholdPoints,
      autoReloadAmountDollars: settings?.auto_reload_amount_dollars,
      autoReloadOperationPending: !!settings?.auto_reload_operation_id,
      monthlyCapDollars:
        monthlyCapPoints === undefined
          ? undefined
          : pointsToDollars(monthlyCapPoints),
      monthlySpentDollars: pointsToDollars(monthlySpentPoints),
      monthlyRemainingDollars:
        monthlyRemainingPoints === undefined
          ? undefined
          : pointsToDollars(monthlyRemainingPoints),
    };
  },
});

/**
 * Minimal frontend entitlement check for HackerAI Max on paid personal plans.
 * The selector uses this instead of subscribing to broad customization and
 * balance payloads just to answer whether Extra Usage can unlock Max.
 */
export const getMaxModelExtraUsageEntitlement = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      extraUsageAvailable: v.boolean(),
      reason: v.union(
        v.literal("available"),
        v.literal("disabled"),
        v.literal("empty"),
        v.literal("monthly_cap_exhausted"),
      ),
      hasBalance: v.boolean(),
      autoReloadEnabled: v.boolean(),
      monthlyRemainingDollars: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    const [customization, settings] = await Promise.all([
      ctx.db
        .query("user_customization")
        .withIndex("by_user_id", (q) => q.eq("user_id", identity.subject))
        .first(),
      ctx.db
        .query("extra_usage")
        .withIndex("by_user_id", (q) => q.eq("user_id", identity.subject))
        .first(),
    ]);

    const enabled = customization?.extra_usage_enabled ?? false;
    const hasBalance = (settings?.balance_points ?? 0) > 0;
    const autoReloadEnabled = settings?.auto_reload_enabled ?? false;
    const monthlySpentPoints = getMonthlySpentPointsForCurrentMonth(settings);
    const monthlyCapPoints = settings?.monthly_cap_points;
    const monthlyRemainingPoints =
      monthlyCapPoints === undefined
        ? undefined
        : Math.max(0, monthlyCapPoints - monthlySpentPoints);
    const monthlyCapExhausted =
      monthlyRemainingPoints !== undefined && monthlyRemainingPoints <= 0;

    let reason: MaxModelExtraUsageReason = "available";
    if (!enabled) {
      reason = "disabled";
    } else if (monthlyCapExhausted) {
      reason = "monthly_cap_exhausted";
    } else if (!hasBalance && !autoReloadEnabled) {
      reason = "empty";
    }

    return {
      extraUsageAvailable: reason === "available",
      reason,
      hasBalance,
      autoReloadEnabled,
      monthlyRemainingDollars:
        monthlyRemainingPoints === undefined
          ? undefined
          : pointsToDollars(monthlyRemainingPoints),
    };
  },
});

/**
 * Get user's extra usage settings (for frontend).
 * Returns all values in dollars (converted from points storage).
 */
export const getExtraUsageSettings = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      balanceDollars: v.number(),
      autoReloadEnabled: v.boolean(),
      autoReloadThresholdDollars: v.optional(v.number()),
      autoReloadAmountDollars: v.optional(v.number()),
      monthlyCapDollars: v.optional(v.number()),
      monthlySpentDollars: v.number(),
      // If auto-reload was auto-disabled because the saved card kept failing,
      // surface a human-readable reason so the UI can prompt the user to fix it.
      autoReloadDisabledReason: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    const settings = await ctx.db
      .query("extra_usage")
      .withIndex("by_user_id", (q) => q.eq("user_id", identity.subject))
      .first();

    if (!settings) {
      return null;
    }

    return {
      balanceDollars: pointsToDollars(settings.balance_points),
      autoReloadEnabled: settings.auto_reload_enabled ?? false,
      autoReloadThresholdDollars: settings.auto_reload_threshold_points
        ? pointsToDollars(settings.auto_reload_threshold_points)
        : undefined,
      autoReloadAmountDollars: settings.auto_reload_amount_dollars,
      monthlyCapDollars:
        settings.monthly_cap_points === undefined
          ? undefined
          : pointsToDollars(settings.monthly_cap_points),
      monthlySpentDollars: pointsToDollars(settings.monthly_spent_points ?? 0),
      autoReloadDisabledReason: settings.auto_reload_disabled_reason,
    };
  },
});

/**
 * Update extra usage settings (auto-reload config).
 * Accepts dollars for threshold, converts to points for storage.
 * Auto-reload amount stays in dollars (for Stripe charges).
 */
export const updateExtraUsageSettings = mutation({
  args: {
    autoReloadEnabled: v.optional(v.boolean()),
    autoReloadThresholdDollars: v.optional(v.number()),
    autoReloadAmountDollars: v.optional(v.number()),
    monthlyCapDollars: v.optional(v.union(v.null(), v.number())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    // Validate whole dollar amounts (no cents allowed)
    if (
      args.autoReloadThresholdDollars !== undefined &&
      !Number.isInteger(args.autoReloadThresholdDollars)
    ) {
      throw new Error("Threshold must be a whole dollar amount");
    }
    if (
      args.autoReloadAmountDollars !== undefined &&
      !Number.isInteger(args.autoReloadAmountDollars)
    ) {
      throw new Error("Reload amount must be a whole dollar amount");
    }
    // Validate minimum threshold of $5
    if (
      args.autoReloadThresholdDollars !== undefined &&
      args.autoReloadThresholdDollars < 5
    ) {
      throw new Error("Threshold must be at least $5");
    }
    // Validate minimum reload amount of $15
    if (
      args.autoReloadAmountDollars !== undefined &&
      args.autoReloadAmountDollars < 15
    ) {
      throw new Error("Reload amount must be at least $15");
    }
    // Validate reload amount is at least $10 more than threshold
    if (
      args.autoReloadAmountDollars !== undefined &&
      args.autoReloadThresholdDollars !== undefined &&
      args.autoReloadAmountDollars < args.autoReloadThresholdDollars + 10
    ) {
      throw new Error("Reload amount must be at least $10 more than threshold");
    }
    validateMonthlyCapDollars(args.monthlyCapDollars);

    const settings = await ctx.db
      .query("extra_usage")
      .withIndex("by_user_id", (q) => q.eq("user_id", identity.subject))
      .first();

    const updateData: Record<string, unknown> = {
      updated_at: Date.now(),
    };

    if (args.autoReloadEnabled !== undefined) {
      updateData.auto_reload_enabled = args.autoReloadEnabled;
      // When the user re-enables auto-reload, clear the prior failure state so
      // the auto-disable banner goes away and the failure counter restarts.
      if (args.autoReloadEnabled) {
        updateData.auto_reload_disabled_reason = undefined;
        updateData.auto_reload_consecutive_failures = 0;
        updateData.auto_reload_retry_after = undefined;
        updateData.auto_reload_last_failure_reason = undefined;
      }
    }
    if (args.autoReloadThresholdDollars !== undefined) {
      updateData.auto_reload_threshold_points = dollarsToPoints(
        args.autoReloadThresholdDollars,
      );
    }
    if (args.autoReloadAmountDollars !== undefined) {
      // Keep in dollars for Stripe charges
      updateData.auto_reload_amount_dollars = args.autoReloadAmountDollars;
    }
    if (args.monthlyCapDollars !== undefined) {
      // null means unlimited (clear the cap), number sets a specific cap
      updateData.monthly_cap_points =
        args.monthlyCapDollars === null
          ? undefined
          : dollarsToPoints(args.monthlyCapDollars);
    }

    if (settings) {
      await ctx.db.patch(settings._id, updateData);
    } else {
      await ctx.db.insert("extra_usage", {
        user_id: identity.subject,
        balance_points: 0,
        ...updateData,
        updated_at: Date.now(),
      });
    }

    return null;
  },
});

/**
 * Record the outcome of an auto-reload attempt.
 *
 * On success: reset the consecutive-failure counter.
 * On failure: increment the counter, and after MAX_AUTO_RELOAD_FAILURES
 * consecutive failures auto-disable auto-reload and store a human-readable
 * reason. This prevents a broken saved card from retrying every overage
 * request.
 */
const MAX_AUTO_RELOAD_FAILURES = 2;

export const recordAutoReloadOutcome = internalMutation({
  args: {
    userId: v.string(),
    success: v.boolean(),
    failureReason: v.optional(v.string()),
  },
  returns: v.object({
    autoReloadDisabled: v.boolean(),
    consecutiveFailures: v.number(),
  }),
  handler: async (ctx, args) => {
    const settings = await ctx.db
      .query("extra_usage")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .first();

    if (!settings) {
      return { autoReloadDisabled: false, consecutiveFailures: 0 };
    }

    if (args.success) {
      if ((settings.auto_reload_consecutive_failures ?? 0) === 0) {
        return { autoReloadDisabled: false, consecutiveFailures: 0 };
      }
      await ctx.db.patch(settings._id, {
        auto_reload_consecutive_failures: 0,
        updated_at: Date.now(),
      });
      return { autoReloadDisabled: false, consecutiveFailures: 0 };
    }

    const next = (settings.auto_reload_consecutive_failures ?? 0) + 1;
    const shouldDisable = next >= MAX_AUTO_RELOAD_FAILURES;

    await ctx.db.patch(settings._id, {
      auto_reload_consecutive_failures: next,
      ...(shouldDisable
        ? {
            auto_reload_enabled: false,
            auto_reload_disabled_reason: args.failureReason ?? "payment_failed",
          }
        : {}),
      updated_at: Date.now(),
    });

    convexLogger.info("auto_reload_outcome", {
      user_id: args.userId,
      success: false,
      failure_reason: args.failureReason,
      consecutive_failures: next,
      auto_reload_disabled: shouldDisable,
    });

    return { autoReloadDisabled: shouldDisable, consecutiveFailures: next };
  },
});
