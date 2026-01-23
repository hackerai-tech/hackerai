import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./chats";

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
// Balance Management (Mutations)
// =============================================================================

/**
 * Add credits to user balance (after successful Stripe payment).
 * Accepts dollars, stores in points internally, returns dollars.
 */
export const addCredits = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    amountDollars: v.number(),
  },
  returns: v.object({
    newBalance: v.number(), // Returns dollars
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const amountPoints = dollarsToPoints(args.amountDollars);

    // Get current settings
    const settings = await ctx.db
      .query("extra_usage")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .first();

    const currentBalancePoints = settings?.balance_points ?? 0;
    const newBalancePoints = currentBalancePoints + amountPoints;

    // Update or create settings
    if (settings) {
      await ctx.db.patch(settings._id, {
        balance_points: newBalancePoints,
        updated_at: Date.now(),
      });
    } else {
      await ctx.db.insert("extra_usage", {
        user_id: args.userId,
        balance_points: newBalancePoints,
        updated_at: Date.now(),
      });
    }

    return { newBalance: pointsToDollars(newBalancePoints) };
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
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    // Get current settings
    const settings = await ctx.db
      .query("extra_usage")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .first();

    if (!settings) {
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
    if (monthlyCapPoints !== undefined && monthlyCapPoints !== null) {
      const newMonthlySpent = monthlySpentPoints + args.amountPoints;
      if (newMonthlySpent > monthlyCapPoints) {
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

    return {
      success: true,
      newBalancePoints,
      newBalanceDollars: pointsToDollars(newBalancePoints),
      insufficientFunds: false,
      monthlyCapExceeded: false,
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
      monthlyCapDollars: settings.monthly_cap_points
        ? pointsToDollars(settings.monthly_cap_points)
        : undefined,
      monthlySpentDollars: pointsToDollars(settings.monthly_spent_points ?? 0),
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
    monthlyCapDollars: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
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
      updateData.auto_reload_threshold_points = dollarsToPoints(
        args.autoReloadThresholdDollars,
      );
    }
    if (args.autoReloadAmountDollars !== undefined) {
      // Keep in dollars for Stripe charges
      updateData.auto_reload_amount_dollars = args.autoReloadAmountDollars;
    }
    if (args.monthlyCapDollars !== undefined) {
      updateData.monthly_cap_points = dollarsToPoints(args.monthlyCapDollars);
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
