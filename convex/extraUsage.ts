import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";
import { convexLogger } from "./lib/logger";

// =============================================================================
// Currency Conversion Helpers
// All monetary values are stored in POINTS internally for precision.
// 1 point = $0.0001 (10,000 points = $1), matching the rate limiting system.
// This avoids precision loss when deducting sub-cent amounts.
// =============================================================================

/** Points per dollar (1 point = $0.0001) - must match token-bucket.ts */
const POINTS_PER_DOLLAR = 10_000;

/** Convert dollars to points (for storage) */
const dollarsToPoints = (dollars: number): number =>
  Math.round(dollars * POINTS_PER_DOLLAR);

/** Convert points to dollars (for API response) */
const pointsToDollars = (points: number): number => points / POINTS_PER_DOLLAR;

// =============================================================================
// Trust-Based Spending Cap
// =============================================================================

/**
 * Trust tier thresholds (modeled after Anthropic API tiers).
 * Both cumulative spend AND account age (since first charge) must be met to advance.
 *
 * Tier 1: cumulative_spend < $5  OR account < 7 days   → $100/month cap
 * Tier 2: cumulative_spend >= $5  AND account >= 7 days  → $500/month cap
 * Tier 3: cumulative_spend >= $40 AND account >= 30 days → $1,000/month cap
 * Tier 4: cumulative_spend >= $200 AND account >= 60 days → uncapped
 */
const TRUST_TIERS = [
  { minSpend: 200, minAgeDays: 60, capDollars: null }, // Tier 4: uncapped
  { minSpend: 40, minAgeDays: 30, capDollars: 1000 }, // Tier 3
  { minSpend: 5, minAgeDays: 7, capDollars: 500 }, // Tier 2
] as const;

const DEFAULT_TRUST_CAP_DOLLARS = 100; // Tier 1 default

const DAYS_MS = 24 * 60 * 60 * 1000;

export type TrustReason =
  | "trusted" // Tier 4: fully uncapped
  | "building-history" // Tier 1-3: need more spend/time
  | "override"; // Manual override by support

/**
 * Compute the effective monthly extra usage spending cap based on trust signals.
 * Returns null if uncapped (trusted user or manual override with no limit).
 */
export function computeExtraUsageCap(settings: {
  first_successful_charge_at?: number;
  cumulative_spend_dollars?: number;
  override_monthly_cap_dollars?: number;
}): { capDollars: number | null; trustReason: TrustReason } {
  // Manual override takes precedence
  if (settings.override_monthly_cap_dollars !== undefined) {
    return {
      capDollars: settings.override_monthly_cap_dollars,
      trustReason: "override",
    };
  }

  const cumulativeSpend = settings.cumulative_spend_dollars ?? 0;
  const firstChargeAt = settings.first_successful_charge_at;
  const accountAgeDays = firstChargeAt
    ? (Date.now() - firstChargeAt) / DAYS_MS
    : 0;

  // Check tiers from highest to lowest
  for (const tier of TRUST_TIERS) {
    if (cumulativeSpend >= tier.minSpend && accountAgeDays >= tier.minAgeDays) {
      return {
        capDollars: tier.capDollars,
        trustReason: tier.capDollars === null ? "trusted" : "building-history",
      };
    }
  }

  // Default: Tier 1
  return {
    capDollars: DEFAULT_TRUST_CAP_DOLLARS,
    trustReason: "building-history",
  };
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

    const existing = await ctx.db
      .query("processed_webhooks")
      .withIndex("by_event_id", (q) => q.eq("event_id", args.eventId))
      .first();

    if (existing) {
      return { alreadyProcessed: true };
    }

    if (!args.checkOnly) {
      await ctx.db.insert("processed_webhooks", {
        event_id: args.eventId,
        processed_at: Date.now(),
      });
    }

    return { alreadyProcessed: false };
  },
});

// =============================================================================
// Balance Management (Mutations)
// =============================================================================

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
  },
  returns: v.object({
    newBalance: v.number(), // Returns dollars
    alreadyProcessed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    // Idempotency: skip if already processed (prevents double-credit on webhook retries
    // and across both the post-checkout confirm path and the async webhook path)
    const dedupKeys = [args.idempotencyKey, args.legacyIdempotencyKey].filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );
    for (const key of dedupKeys) {
      const existing = await ctx.db
        .query("processed_webhooks")
        .withIndex("by_event_id", (q) => q.eq("event_id", key))
        .first();

      if (existing) {
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

    // Update or create settings (also track trust fields)
    const now = Date.now();
    if (settings) {
      await ctx.db.patch(settings._id, {
        balance_points: newBalancePoints,
        // Track cumulative spend for trust-based caps
        first_successful_charge_at: settings.first_successful_charge_at ?? now,
        cumulative_spend_dollars:
          (settings.cumulative_spend_dollars ?? 0) + args.amountDollars,
        updated_at: now,
      });
    } else {
      await ctx.db.insert("extra_usage", {
        user_id: args.userId,
        balance_points: newBalancePoints,
        first_successful_charge_at: now,
        cumulative_spend_dollars: args.amountDollars,
        updated_at: now,
      });
    }

    // Mark processed after success (so retries work if above fails)
    if (args.idempotencyKey) {
      await ctx.db.insert("processed_webhooks", {
        event_id: args.idempotencyKey,
        processed_at: Date.now(),
      });
    }

    convexLogger.info("credits_added", {
      user_id: args.userId,
      amount_dollars: args.amountDollars,
      amount_points: amountPoints,
      new_balance_points: newBalancePoints,
      new_balance_dollars: pointsToDollars(newBalancePoints),
      idempotency_key: args.idempotencyKey,
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
  },
  returns: v.object({
    success: v.boolean(),
    newBalancePoints: v.number(),
    newBalanceDollars: v.number(),
    insufficientFunds: v.boolean(),
    monthlyCapExceeded: v.boolean(),
    trustCapExceeded: v.optional(v.boolean()),
    trustCapDollars: v.optional(v.union(v.null(), v.number())),
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

    // Compute effective monthly cap: lower of user-set cap and trust-based cap
    const userCapPoints = settings.monthly_cap_points;
    const { capDollars: trustCapDollars } = computeExtraUsageCap(settings);
    const trustCapPoints =
      trustCapDollars !== null ? dollarsToPoints(trustCapDollars) : undefined;

    // Use the most restrictive cap (lowest non-undefined value)
    let effectiveCapPoints: number | undefined;
    if (userCapPoints !== undefined && trustCapPoints !== undefined) {
      effectiveCapPoints = Math.min(userCapPoints, trustCapPoints);
    } else {
      effectiveCapPoints = userCapPoints ?? trustCapPoints;
    }

    // Determine which cap triggered (for frontend error messaging)
    const isTrustCap =
      effectiveCapPoints !== undefined &&
      trustCapPoints !== undefined &&
      effectiveCapPoints === trustCapPoints &&
      (userCapPoints === undefined || trustCapPoints <= userCapPoints);

    // Check monthly spending cap before deducting
    if (effectiveCapPoints !== undefined) {
      const newMonthlySpent = monthlySpentPoints + args.amountPoints;
      if (newMonthlySpent > effectiveCapPoints) {
        convexLogger.warn("deduct_points_failed", {
          user_id: args.userId,
          amount_points: args.amountPoints,
          monthly_spent_points: monthlySpentPoints,
          effective_cap_points: effectiveCapPoints,
          trust_cap_dollars: trustCapDollars,
          is_trust_cap: isTrustCap,
          reason: isTrustCap ? "trust_cap_exceeded" : "monthly_cap_exceeded",
          monthly_cap_exceeded: true,
        });
        return {
          success: false,
          newBalancePoints: currentBalancePoints,
          newBalanceDollars: pointsToDollars(currentBalancePoints),
          insufficientFunds: true,
          monthlyCapExceeded: true,
          trustCapExceeded: isTrustCap,
          trustCapDollars: isTrustCap ? trustCapDollars : undefined,
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
      previous_balance_points: currentBalancePoints,
      new_balance_points: newBalancePoints,
      monthly_spent_points: monthlySpentPoints,
      monthly_cap_points: effectiveCapPoints,
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
      // Trust-based spending cap
      trustCapDollars: v.union(v.null(), v.number()), // null = uncapped
      trustReason: v.string(),
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

    const { capDollars, trustReason } = computeExtraUsageCap(settings);

    return {
      balanceDollars: pointsToDollars(settings.balance_points),
      autoReloadEnabled: settings.auto_reload_enabled ?? false,
      autoReloadThresholdDollars: settings.auto_reload_threshold_points
        ? pointsToDollars(settings.auto_reload_threshold_points)
        : undefined,
      autoReloadAmountDollars: settings.auto_reload_amount_dollars,
      monthlyCapDollars: settings.monthly_cap_points
        ? pointsToDollars(settings.monthly_cap_points)
        : undefined,
      monthlySpentDollars: pointsToDollars(settings.monthly_spent_points ?? 0),
      trustCapDollars: capDollars,
      trustReason,
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
