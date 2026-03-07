import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";
import { convexLogger } from "./lib/logger";

// =============================================================================
// Webhook Idempotency
// =============================================================================

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
// Migration helpers — read new dollar fields, fall back to legacy points / 10,000
// =============================================================================
const LEGACY_POINTS_PER_DOLLAR = 10_000;

function readBalanceDollars(
  settings: { balance_dollars?: number; balance_points?: number } | null,
): number {
  if (!settings) return 0;
  if (
    settings.balance_dollars !== undefined &&
    settings.balance_dollars !== null
  ) {
    return settings.balance_dollars;
  }
  if (
    settings.balance_points !== undefined &&
    settings.balance_points !== null
  ) {
    return settings.balance_points / LEGACY_POINTS_PER_DOLLAR;
  }
  return 0;
}

function readThresholdDollars(
  settings: {
    auto_reload_threshold_dollars?: number;
    auto_reload_threshold_points?: number;
  } | null,
): number | undefined {
  if (!settings) return undefined;
  if (
    settings.auto_reload_threshold_dollars !== undefined &&
    settings.auto_reload_threshold_dollars !== null
  ) {
    return settings.auto_reload_threshold_dollars;
  }
  if (
    settings.auto_reload_threshold_points !== undefined &&
    settings.auto_reload_threshold_points !== null
  ) {
    return settings.auto_reload_threshold_points / LEGACY_POINTS_PER_DOLLAR;
  }
  return undefined;
}

function readMonthlyCapDollars(
  settings: {
    monthly_cap_dollars?: number;
    monthly_cap_points?: number;
  } | null,
): number | undefined {
  if (!settings) return undefined;
  if (
    settings.monthly_cap_dollars !== undefined &&
    settings.monthly_cap_dollars !== null
  ) {
    return settings.monthly_cap_dollars;
  }
  if (
    settings.monthly_cap_points !== undefined &&
    settings.monthly_cap_points !== null
  ) {
    return settings.monthly_cap_points / LEGACY_POINTS_PER_DOLLAR;
  }
  return undefined;
}

function readMonthlySpentDollars(
  settings: {
    monthly_spent_dollars?: number;
    monthly_spent_points?: number;
  } | null,
): number {
  if (!settings) return 0;
  if (
    settings.monthly_spent_dollars !== undefined &&
    settings.monthly_spent_dollars !== null
  ) {
    return settings.monthly_spent_dollars;
  }
  if (
    settings.monthly_spent_points !== undefined &&
    settings.monthly_spent_points !== null
  ) {
    return settings.monthly_spent_points / LEGACY_POINTS_PER_DOLLAR;
  }
  return 0;
}

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
    idempotencyKey: v.optional(v.string()), // Stripe event ID for webhook deduplication
  },
  returns: v.object({
    newBalance: v.number(), // Returns dollars
    alreadyProcessed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    // Idempotency: skip if already processed (prevents double-credit on webhook retries)
    if (args.idempotencyKey) {
      const existing = await ctx.db
        .query("processed_webhooks")
        .withIndex("by_event_id", (q) => q.eq("event_id", args.idempotencyKey!))
        .first();

      if (existing) {
        return { newBalance: 0, alreadyProcessed: true };
      }
    }

    // Validate amount
    if (isNaN(args.amountDollars) || args.amountDollars <= 0) {
      throw new Error("Invalid amount: must be a positive number");
    }

    // Get current settings
    const settings = await ctx.db
      .query("extra_usage")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .first();

    const currentBalance = readBalanceDollars(settings);
    const newBalance = currentBalance + args.amountDollars;

    // Update or create settings (always write to new dollar fields)
    if (settings) {
      await ctx.db.patch(settings._id, {
        balance_dollars: newBalance,
        balance_points: undefined, // clear legacy field
        updated_at: Date.now(),
      });
    } else {
      await ctx.db.insert("extra_usage", {
        user_id: args.userId,
        balance_dollars: newBalance,
        updated_at: Date.now(),
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
      new_balance_dollars: newBalance,
      idempotency_key: args.idempotencyKey,
    });

    return {
      newBalance,
      alreadyProcessed: false,
    };
  },
});

/**
 * Deduct from user balance for usage.
 * Accepts dollar amount directly.
 */
export const deductBalance = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    amountDollars: v.number(),
  },
  returns: v.object({
    success: v.boolean(),
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
      convexLogger.warn("deduct_balance_failed", {
        user_id: args.userId,
        amount_dollars: args.amountDollars,
        reason: "no_settings",
        insufficient_funds: true,
      });
      return {
        success: false,
        newBalanceDollars: 0,
        insufficientFunds: true,
        monthlyCapExceeded: false,
      };
    }

    const currentBalance = readBalanceDollars(settings);

    // Check if user has enough balance
    if (currentBalance < args.amountDollars) {
      convexLogger.warn("deduct_balance_failed", {
        user_id: args.userId,
        amount_dollars: args.amountDollars,
        current_balance_dollars: currentBalance,
        reason: "insufficient_balance",
        insufficient_funds: true,
      });
      return {
        success: false,
        newBalanceDollars: currentBalance,
        insufficientFunds: true,
        monthlyCapExceeded: false,
      };
    }

    // Calculate current month for tracking
    const now = new Date();
    const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

    // Reset monthly spending if month changed
    let monthlySpent = readMonthlySpentDollars(settings);
    const shouldResetMonthly = settings.monthly_reset_date !== currentMonth;
    if (shouldResetMonthly) {
      monthlySpent = 0;
    }

    // Check monthly spending cap before deducting
    const monthlyCap = readMonthlyCapDollars(settings);
    if (monthlyCap !== undefined && monthlyCap !== null) {
      const newMonthlySpent = monthlySpent + args.amountDollars;
      if (newMonthlySpent > monthlyCap) {
        convexLogger.warn("deduct_balance_failed", {
          user_id: args.userId,
          amount_dollars: args.amountDollars,
          monthly_spent_dollars: monthlySpent,
          monthly_cap_dollars: monthlyCap,
          reason: "monthly_cap_exceeded",
          monthly_cap_exceeded: true,
        });
        return {
          success: false,
          newBalanceDollars: currentBalance,
          insufficientFunds: true,
          monthlyCapExceeded: true,
        };
      }
    }

    // Add to monthly spending
    monthlySpent += args.amountDollars;

    // Deduct balance and update monthly tracking (write to new fields, clear legacy)
    const newBalance = currentBalance - args.amountDollars;
    await ctx.db.patch(settings._id, {
      balance_dollars: newBalance,
      balance_points: undefined,
      monthly_spent_dollars: monthlySpent,
      monthly_spent_points: undefined,
      monthly_cap_dollars: monthlyCap,
      monthly_cap_points: undefined,
      monthly_reset_date: currentMonth,
      updated_at: Date.now(),
    });

    convexLogger.info("balance_deducted", {
      user_id: args.userId,
      amount_dollars: args.amountDollars,
      previous_balance_dollars: currentBalance,
      new_balance_dollars: newBalance,
      monthly_spent_dollars: monthlySpent,
      monthly_cap_dollars: monthlyCap,
    });

    return {
      success: true,
      newBalanceDollars: newBalance,
      insufficientFunds: false,
      monthlyCapExceeded: false,
    };
  },
});

/**
 * Refund dollars to user balance (for failed requests).
 * This is the reverse of deductBalance - adds dollars back to the balance.
 * Does NOT affect monthly spending tracking (refunds don't reduce spent amount).
 */
export const refundBalance = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    amountDollars: v.number(),
  },
  returns: v.object({
    success: v.boolean(),
    newBalanceDollars: v.number(),
    noOp: v.optional(v.boolean()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    // No-op: nothing to refund
    if (args.amountDollars <= 0) {
      return {
        success: true,
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
        balance_dollars: args.amountDollars,
        updated_at: Date.now(),
      });

      convexLogger.info("balance_refunded", {
        user_id: args.userId,
        amount_dollars: args.amountDollars,
        previous_balance_dollars: 0,
        new_balance_dollars: args.amountDollars,
        created_new_record: true,
      });

      return {
        success: true,
        newBalanceDollars: args.amountDollars,
      };
    }

    const currentBalance = readBalanceDollars(settings);
    const newBalance = currentBalance + args.amountDollars;

    await ctx.db.patch(settings._id, {
      balance_dollars: newBalance,
      balance_points: undefined, // clear legacy field
      updated_at: Date.now(),
    });

    convexLogger.info("balance_refunded", {
      user_id: args.userId,
      amount_dollars: args.amountDollars,
      previous_balance_dollars: currentBalance,
      new_balance_dollars: newBalance,
    });

    return {
      success: true,
      newBalanceDollars: newBalance,
    };
  },
});

// =============================================================================
// Queries
// =============================================================================

/**
 * Get user's extra usage balance and settings (for backend).
 */
export const getExtraUsageBalanceForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
  },
  returns: v.object({
    balanceDollars: v.number(),
    enabled: v.boolean(),
    autoReloadEnabled: v.boolean(),
    autoReloadThresholdDollars: v.optional(v.number()),
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

    return {
      balanceDollars: readBalanceDollars(settings),
      enabled: customization?.extra_usage_enabled ?? false,
      autoReloadEnabled: settings?.auto_reload_enabled ?? false,
      autoReloadThresholdDollars: readThresholdDollars(settings),
      autoReloadAmountDollars: settings?.auto_reload_amount_dollars,
    };
  },
});

/**
 * Get user's extra usage settings (for frontend).
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
      balanceDollars: readBalanceDollars(settings),
      autoReloadEnabled: settings.auto_reload_enabled ?? false,
      autoReloadThresholdDollars: readThresholdDollars(settings),
      autoReloadAmountDollars: settings.auto_reload_amount_dollars,
      monthlyCapDollars: readMonthlyCapDollars(settings),
      monthlySpentDollars: readMonthlySpentDollars(settings),
    };
  },
});

/**
 * Update extra usage settings (auto-reload config).
 * All monetary values in dollars.
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
    }
    if (args.autoReloadThresholdDollars !== undefined) {
      updateData.auto_reload_threshold_dollars =
        args.autoReloadThresholdDollars;
    }
    if (args.autoReloadAmountDollars !== undefined) {
      updateData.auto_reload_amount_dollars = args.autoReloadAmountDollars;
    }
    if (args.monthlyCapDollars !== undefined) {
      // null means unlimited (clear the cap), number sets a specific cap
      updateData.monthly_cap_dollars =
        args.monthlyCapDollars === null ? undefined : args.monthlyCapDollars;
    }

    if (settings) {
      await ctx.db.patch(settings._id, updateData);
    } else {
      await ctx.db.insert("extra_usage", {
        user_id: identity.subject,
        balance_dollars: 0,
        ...updateData,
        updated_at: Date.now(),
      });
    }

    return null;
  },
});
