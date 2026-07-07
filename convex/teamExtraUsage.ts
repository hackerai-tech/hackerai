import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";
import { convexLogger } from "./lib/logger";
import { recordRevenueEventInternal } from "./unitEconomicsLib";
import {
  extraUsageDollarsToPoints as dollarsToPoints,
  extraUsagePointsToDollars as pointsToDollars,
} from "./lib/extraUsagePricing";
import { validateMonthlyCapDollars } from "./lib/extraUsageValidation";

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Get-or-create the team_extra_usage row for an org. Mutates DB only when
 * the row doesn't exist yet. Returns the row.
 */
async function ensureTeamRow(ctx: MutationCtx, organizationId: string) {
  const existing = await ctx.db
    .query("team_extra_usage")
    .withIndex("by_org", (q) => q.eq("organization_id", organizationId))
    .first();

  if (existing) return existing;

  const id = await ctx.db.insert("team_extra_usage", {
    organization_id: organizationId,
    balance_points: 0,
    updated_at: Date.now(),
  });
  const inserted = await ctx.db.get(id);
  if (!inserted) throw new Error("Failed to create team_extra_usage row");
  return inserted;
}

async function ensureMemberRow(
  ctx: MutationCtx,
  organizationId: string,
  userId: string,
) {
  const existing = await ctx.db
    .query("team_member_usage")
    .withIndex("by_org_user", (q) =>
      q.eq("organization_id", organizationId).eq("user_id", userId),
    )
    .first();

  if (existing) return existing;

  const id = await ctx.db.insert("team_member_usage", {
    organization_id: organizationId,
    user_id: userId,
    updated_at: Date.now(),
  });
  const inserted = await ctx.db.get(id);
  if (!inserted) throw new Error("Failed to create team_member_usage row");
  return inserted;
}

function currentMonthString(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

// =============================================================================
// Balance Management (Mutations)
// =============================================================================

/**
 * Add credits to team balance (after successful Stripe payment).
 * Idempotent via optional idempotencyKey (Stripe session ID).
 */
export const addTeamCredits = mutation({
  args: {
    serviceKey: v.string(),
    organizationId: v.string(),
    amountDollars: v.number(),
    idempotencyKey: v.optional(v.string()),
    legacyIdempotencyKey: v.optional(v.string()),
    revenueSource: v.optional(
      v.union(
        v.literal("team_extra_usage_purchase"),
        v.literal("team_extra_usage_auto_reload"),
      ),
    ),
    stripeCustomerId: v.optional(v.string()),
    stripeCheckoutSessionId: v.optional(v.string()),
    stripePaymentIntentId: v.optional(v.string()),
  },
  returns: v.object({
    newBalance: v.number(),
    alreadyProcessed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const sessionKey = args.idempotencyKey;
    if (sessionKey) {
      const durableExisting = await ctx.db
        .query("processed_checkout_sessions")
        .withIndex("by_session_key", (q) => q.eq("session_key", sessionKey))
        .unique();
      if (durableExisting) {
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
        return { newBalance: 0, alreadyProcessed: true };
      }
    }

    if (isNaN(args.amountDollars) || args.amountDollars <= 0) {
      throw new Error("Invalid amount: must be a positive number");
    }

    const amountPoints = dollarsToPoints(args.amountDollars);

    const row = await ctx.db
      .query("team_extra_usage")
      .withIndex("by_org", (q) => q.eq("organization_id", args.organizationId))
      .first();

    const currentBalancePoints = row?.balance_points ?? 0;
    const newBalancePoints = currentBalancePoints + amountPoints;
    const now = Date.now();

    if (row) {
      await ctx.db.patch(row._id, {
        balance_points: newBalancePoints,
        updated_at: now,
      });
    } else {
      await ctx.db.insert("team_extra_usage", {
        organization_id: args.organizationId,
        balance_points: newBalancePoints,
        updated_at: now,
      });
    }

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
      entityType: "organization",
      entityId: args.organizationId,
      organizationId: args.organizationId,
      source: "team_extra_usage",
      sourceEventId:
        args.stripeCheckoutSessionId ??
        args.stripePaymentIntentId ??
        args.idempotencyKey ??
        `team_extra_usage:${args.organizationId}:${Date.now()}`,
      idempotencyKey:
        args.idempotencyKey ??
        args.stripePaymentIntentId ??
        args.stripeCheckoutSessionId,
      grossRevenueDollars: args.amountDollars,
      currency: "usd",
      attributionStrategy: "organization_pool",
      stripeCustomerId: args.stripeCustomerId,
      stripeCheckoutSessionId: args.stripeCheckoutSessionId,
      stripePaymentIntentId: args.stripePaymentIntentId,
      description: args.revenueSource ?? "team_extra_usage_purchase",
    });

    convexLogger.info("team_credits_added", {
      organization_id: args.organizationId,
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
 * Deduct from team balance for a specific member. Enforces:
 *   - team pool enabled
 *   - member not disabled
 *   - member's per-member cap
 *   - team's monthly cap
 *   - sufficient team balance
 */
export const deductTeamPoints = mutation({
  args: {
    serviceKey: v.string(),
    organizationId: v.string(),
    userId: v.string(),
    amountPoints: v.number(),
  },
  returns: v.object({
    success: v.boolean(),
    newBalancePoints: v.number(),
    newBalanceDollars: v.number(),
    insufficientFunds: v.boolean(),
    monthlyCapExceeded: v.boolean(),
    memberCapExceeded: v.boolean(),
    memberDisabled: v.boolean(),
    poolDisabled: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const team = await ctx.db
      .query("team_extra_usage")
      .withIndex("by_org", (q) => q.eq("organization_id", args.organizationId))
      .first();

    if (!team || !(team.enabled ?? false)) {
      return {
        success: false,
        newBalancePoints: 0,
        newBalanceDollars: 0,
        insufficientFunds: true,
        monthlyCapExceeded: false,
        memberCapExceeded: false,
        memberDisabled: false,
        poolDisabled: true,
      };
    }

    const member = await ctx.db
      .query("team_member_usage")
      .withIndex("by_org_user", (q) =>
        q.eq("organization_id", args.organizationId).eq("user_id", args.userId),
      )
      .first();

    if (member?.disabled) {
      return {
        success: false,
        newBalancePoints: team.balance_points ?? 0,
        newBalanceDollars: pointsToDollars(team.balance_points ?? 0),
        insufficientFunds: true,
        monthlyCapExceeded: false,
        memberCapExceeded: false,
        memberDisabled: true,
        poolDisabled: false,
      };
    }

    const currentMonth = currentMonthString();
    const currentBalancePoints = team.balance_points ?? 0;

    // Reset team monthly spent if cycle rolled over
    let teamMonthlySpent = team.monthly_spent_points ?? 0;
    if (team.monthly_reset_date !== currentMonth) {
      teamMonthlySpent = 0;
    }

    // Same for member counter
    let memberMonthlySpent = member?.monthly_spent_points ?? 0;
    const memberShouldReset = member?.monthly_reset_date !== currentMonth;
    if (memberShouldReset) {
      memberMonthlySpent = 0;
    }

    // Team monthly cap check
    const teamCap = team.monthly_cap_points;
    if (teamCap !== undefined) {
      const newTeamSpent = teamMonthlySpent + args.amountPoints;
      if (newTeamSpent > teamCap) {
        return {
          success: false,
          newBalancePoints: currentBalancePoints,
          newBalanceDollars: pointsToDollars(currentBalancePoints),
          insufficientFunds: true,
          monthlyCapExceeded: true,
          memberCapExceeded: false,
          memberDisabled: false,
          poolDisabled: false,
        };
      }
    }

    // Per-member cap check
    const memberCap = member?.monthly_limit_points;
    if (memberCap !== undefined) {
      const newMemberSpent = memberMonthlySpent + args.amountPoints;
      if (newMemberSpent > memberCap) {
        return {
          success: false,
          newBalancePoints: currentBalancePoints,
          newBalanceDollars: pointsToDollars(currentBalancePoints),
          insufficientFunds: true,
          monthlyCapExceeded: false,
          memberCapExceeded: true,
          memberDisabled: false,
          poolDisabled: false,
        };
      }
    }

    if (currentBalancePoints < args.amountPoints) {
      return {
        success: false,
        newBalancePoints: currentBalancePoints,
        newBalanceDollars: pointsToDollars(currentBalancePoints),
        insufficientFunds: true,
        monthlyCapExceeded: false,
        memberCapExceeded: false,
        memberDisabled: false,
        poolDisabled: false,
      };
    }

    // All checks passed — commit
    teamMonthlySpent += args.amountPoints;
    memberMonthlySpent += args.amountPoints;
    const newBalancePoints = currentBalancePoints - args.amountPoints;

    await ctx.db.patch(team._id, {
      balance_points: newBalancePoints,
      monthly_spent_points: teamMonthlySpent,
      monthly_reset_date: currentMonth,
      updated_at: Date.now(),
    });

    if (member) {
      await ctx.db.patch(member._id, {
        monthly_spent_points: memberMonthlySpent,
        monthly_reset_date: currentMonth,
        updated_at: Date.now(),
      });
    } else {
      await ctx.db.insert("team_member_usage", {
        organization_id: args.organizationId,
        user_id: args.userId,
        monthly_spent_points: memberMonthlySpent,
        monthly_reset_date: currentMonth,
        updated_at: Date.now(),
      });
    }

    convexLogger.info("team_points_deducted", {
      organization_id: args.organizationId,
      user_id: args.userId,
      amount_points: args.amountPoints,
      new_balance_points: newBalancePoints,
      team_monthly_spent: teamMonthlySpent,
      member_monthly_spent: memberMonthlySpent,
    });

    return {
      success: true,
      newBalancePoints,
      newBalanceDollars: pointsToDollars(newBalancePoints),
      insufficientFunds: false,
      monthlyCapExceeded: false,
      memberCapExceeded: false,
      memberDisabled: false,
      poolDisabled: false,
    };
  },
});

/**
 * Refund points to team balance (for failed requests).
 * Also decrements member's monthly_spent so they can spend again later.
 */
export const refundTeamPoints = mutation({
  args: {
    serviceKey: v.string(),
    organizationId: v.string(),
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

    if (args.amountPoints <= 0) {
      return {
        success: true,
        newBalancePoints: 0,
        newBalanceDollars: 0,
        noOp: true,
      };
    }

    const team = await ctx.db
      .query("team_extra_usage")
      .withIndex("by_org", (q) => q.eq("organization_id", args.organizationId))
      .first();

    if (!team) {
      // Nothing to refund to — create a row so it can be queried later.
      await ctx.db.insert("team_extra_usage", {
        organization_id: args.organizationId,
        balance_points: args.amountPoints,
        updated_at: Date.now(),
      });
      return {
        success: true,
        newBalancePoints: args.amountPoints,
        newBalanceDollars: pointsToDollars(args.amountPoints),
      };
    }

    const newBalancePoints = (team.balance_points ?? 0) + args.amountPoints;

    await ctx.db.patch(team._id, {
      balance_points: newBalancePoints,
      updated_at: Date.now(),
    });

    // Decrement member's monthly spent to free up their cap
    const member = await ctx.db
      .query("team_member_usage")
      .withIndex("by_org_user", (q) =>
        q.eq("organization_id", args.organizationId).eq("user_id", args.userId),
      )
      .first();

    if (member) {
      const newSpent = Math.max(
        0,
        (member.monthly_spent_points ?? 0) - args.amountPoints,
      );
      await ctx.db.patch(member._id, {
        monthly_spent_points: newSpent,
        updated_at: Date.now(),
      });
    }

    convexLogger.info("team_points_refunded", {
      organization_id: args.organizationId,
      user_id: args.userId,
      amount_points: args.amountPoints,
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
// Backend Queries (for rate limiter)
// =============================================================================

/**
 * Get team's extra usage state (for backend rate limiter).
 * Combines team-pool config + per-member usage state needed for the
 * deduction precheck in token-bucket.ts.
 */
export const getTeamExtraUsageStateForBackend = query({
  args: {
    serviceKey: v.string(),
    organizationId: v.string(),
    userId: v.string(),
  },
  returns: v.object({
    enabled: v.boolean(),
    balanceDollars: v.number(),
    balancePoints: v.number(),
    autoReloadEnabled: v.boolean(),
    autoReloadThresholdDollars: v.optional(v.number()),
    autoReloadThresholdPoints: v.optional(v.number()),
    autoReloadAmountDollars: v.optional(v.number()),
    memberDisabled: v.boolean(),
    monthlyCapDollars: v.optional(v.number()),
    monthlySpentDollars: v.number(),
    memberMonthlyLimitDollars: v.optional(v.number()),
    memberMonthlySpentDollars: v.number(),
    monthlyRemainingDollars: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const team = await ctx.db
      .query("team_extra_usage")
      .withIndex("by_org", (q) => q.eq("organization_id", args.organizationId))
      .first();

    const member = await ctx.db
      .query("team_member_usage")
      .withIndex("by_org_user", (q) =>
        q.eq("organization_id", args.organizationId).eq("user_id", args.userId),
      )
      .first();

    const thresholdPoints = team?.auto_reload_threshold_points;
    const currentMonth = currentMonthString();
    const teamMonthlySpent =
      team?.monthly_reset_date === currentMonth
        ? (team?.monthly_spent_points ?? 0)
        : 0;
    const memberMonthlySpent =
      member?.monthly_reset_date === currentMonth
        ? (member?.monthly_spent_points ?? 0)
        : 0;
    const teamCapPoints = team?.monthly_cap_points;
    const memberCapPoints = member?.monthly_limit_points;
    const teamRemainingPoints =
      teamCapPoints === undefined
        ? undefined
        : Math.max(0, teamCapPoints - teamMonthlySpent);
    const memberRemainingPoints =
      memberCapPoints === undefined
        ? undefined
        : Math.max(0, memberCapPoints - memberMonthlySpent);
    const monthlyRemainingPoints =
      teamRemainingPoints === undefined && memberRemainingPoints === undefined
        ? undefined
        : Math.min(
            teamRemainingPoints ?? Number.POSITIVE_INFINITY,
            memberRemainingPoints ?? Number.POSITIVE_INFINITY,
          );

    return {
      enabled: team?.enabled ?? false,
      balanceDollars: pointsToDollars(team?.balance_points ?? 0),
      balancePoints: team?.balance_points ?? 0,
      autoReloadEnabled: team?.auto_reload_enabled ?? false,
      autoReloadThresholdDollars: thresholdPoints
        ? pointsToDollars(thresholdPoints)
        : undefined,
      autoReloadThresholdPoints: thresholdPoints,
      autoReloadAmountDollars: team?.auto_reload_amount_dollars,
      memberDisabled: member?.disabled ?? false,
      monthlyCapDollars:
        teamCapPoints === undefined
          ? undefined
          : pointsToDollars(teamCapPoints),
      monthlySpentDollars: pointsToDollars(teamMonthlySpent),
      memberMonthlyLimitDollars:
        memberCapPoints === undefined
          ? undefined
          : pointsToDollars(memberCapPoints),
      memberMonthlySpentDollars: pointsToDollars(memberMonthlySpent),
      monthlyRemainingDollars:
        monthlyRemainingPoints === undefined
          ? undefined
          : pointsToDollars(monthlyRemainingPoints),
    };
  },
});

// =============================================================================
// Admin Queries (called from admin-gated API routes; service-key validated)
// =============================================================================

/**
 * Admin dashboard: read team pool settings + the org's member usage list.
 * Member names/emails are NOT included here — the caller (admin API route)
 * already fetched those from WorkOS and merges them in.
 */
export const getTeamExtraUsageAdminView = query({
  args: {
    serviceKey: v.string(),
    organizationId: v.string(),
  },
  returns: v.object({
    enabled: v.boolean(),
    balanceDollars: v.number(),
    autoReloadEnabled: v.boolean(),
    autoReloadThresholdDollars: v.optional(v.number()),
    autoReloadAmountDollars: v.optional(v.number()),
    monthlyCapDollars: v.optional(v.number()),
    monthlySpentDollars: v.number(),
    autoReloadDisabledReason: v.optional(v.string()),
    members: v.array(
      v.object({
        userId: v.string(),
        monthlyLimitDollars: v.optional(v.number()),
        monthlySpentDollars: v.number(),
        disabled: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const team = await ctx.db
      .query("team_extra_usage")
      .withIndex("by_org", (q) => q.eq("organization_id", args.organizationId))
      .first();

    const members = await ctx.db
      .query("team_member_usage")
      .withIndex("by_org", (q) => q.eq("organization_id", args.organizationId))
      .collect();

    const currentMonth = currentMonthString();

    const teamMonthlySpent =
      team?.monthly_reset_date === currentMonth
        ? (team?.monthly_spent_points ?? 0)
        : 0;

    return {
      enabled: team?.enabled ?? false,
      balanceDollars: pointsToDollars(team?.balance_points ?? 0),
      autoReloadEnabled: team?.auto_reload_enabled ?? false,
      autoReloadThresholdDollars: team?.auto_reload_threshold_points
        ? pointsToDollars(team.auto_reload_threshold_points)
        : undefined,
      autoReloadAmountDollars: team?.auto_reload_amount_dollars,
      monthlyCapDollars:
        team?.monthly_cap_points === undefined
          ? undefined
          : pointsToDollars(team.monthly_cap_points),
      monthlySpentDollars: pointsToDollars(teamMonthlySpent),
      autoReloadDisabledReason: team?.auto_reload_disabled_reason,
      members: members.map((m) => {
        const spent =
          m.monthly_reset_date === currentMonth
            ? (m.monthly_spent_points ?? 0)
            : 0;
        return {
          userId: m.user_id,
          monthlyLimitDollars: m.monthly_limit_points
            ? pointsToDollars(m.monthly_limit_points)
            : undefined,
          monthlySpentDollars: pointsToDollars(spent),
          disabled: m.disabled ?? false,
        };
      }),
    };
  },
});

// =============================================================================
// Admin Mutations (service-key validated; admin role check happens in API route)
// =============================================================================

export const updateTeamExtraUsageSettings = mutation({
  args: {
    serviceKey: v.string(),
    organizationId: v.string(),
    enabled: v.optional(v.boolean()),
    autoReloadEnabled: v.optional(v.boolean()),
    autoReloadThresholdDollars: v.optional(v.number()),
    autoReloadAmountDollars: v.optional(v.number()),
    monthlyCapDollars: v.optional(v.union(v.null(), v.number())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    // Same validation rules as user-level updateExtraUsageSettings
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
    if (
      args.autoReloadThresholdDollars !== undefined &&
      args.autoReloadThresholdDollars < 5
    ) {
      throw new Error("Threshold must be at least $5");
    }
    if (
      args.autoReloadAmountDollars !== undefined &&
      args.autoReloadAmountDollars < 15
    ) {
      throw new Error("Reload amount must be at least $15");
    }
    if (
      args.autoReloadAmountDollars !== undefined &&
      args.autoReloadThresholdDollars !== undefined &&
      args.autoReloadAmountDollars < args.autoReloadThresholdDollars + 10
    ) {
      throw new Error("Reload amount must be at least $10 more than threshold");
    }
    validateMonthlyCapDollars(args.monthlyCapDollars);

    const row = await ensureTeamRow(ctx, args.organizationId);

    const updateData: Record<string, unknown> = { updated_at: Date.now() };

    if (args.enabled !== undefined) updateData.enabled = args.enabled;

    if (args.autoReloadEnabled !== undefined) {
      updateData.auto_reload_enabled = args.autoReloadEnabled;
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
      updateData.auto_reload_amount_dollars = args.autoReloadAmountDollars;
    }
    if (args.monthlyCapDollars !== undefined) {
      updateData.monthly_cap_points =
        args.monthlyCapDollars === null
          ? undefined
          : dollarsToPoints(args.monthlyCapDollars);
    }

    await ctx.db.patch(row._id, updateData);
    return null;
  },
});

export const updateTeamMemberUsage = mutation({
  args: {
    serviceKey: v.string(),
    organizationId: v.string(),
    userId: v.string(),
    monthlyLimitDollars: v.optional(v.union(v.null(), v.number())),
    disabled: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    if (
      args.monthlyLimitDollars !== undefined &&
      args.monthlyLimitDollars !== null &&
      args.monthlyLimitDollars < 0
    ) {
      throw new Error("Member spending limit must be non-negative");
    }

    const row = await ensureMemberRow(ctx, args.organizationId, args.userId);

    const updateData: Record<string, unknown> = { updated_at: Date.now() };

    if (args.monthlyLimitDollars !== undefined) {
      updateData.monthly_limit_points =
        args.monthlyLimitDollars === null
          ? undefined
          : dollarsToPoints(args.monthlyLimitDollars);
    }
    if (args.disabled !== undefined) updateData.disabled = args.disabled;

    await ctx.db.patch(row._id, updateData);
    return null;
  },
});

// =============================================================================
// Auto-reload outcome tracking (mirrors user-level recordAutoReloadOutcome)
// =============================================================================

const MAX_AUTO_RELOAD_FAILURES = 2;

export const recordTeamAutoReloadOutcome = internalMutation({
  args: {
    organizationId: v.string(),
    success: v.boolean(),
    failureReason: v.optional(v.string()),
  },
  returns: v.object({
    autoReloadDisabled: v.boolean(),
    consecutiveFailures: v.number(),
  }),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("team_extra_usage")
      .withIndex("by_org", (q) => q.eq("organization_id", args.organizationId))
      .first();

    if (!row) {
      return { autoReloadDisabled: false, consecutiveFailures: 0 };
    }

    if (args.success) {
      if ((row.auto_reload_consecutive_failures ?? 0) === 0) {
        return { autoReloadDisabled: false, consecutiveFailures: 0 };
      }
      await ctx.db.patch(row._id, {
        auto_reload_consecutive_failures: 0,
        updated_at: Date.now(),
      });
      return { autoReloadDisabled: false, consecutiveFailures: 0 };
    }

    const next = (row.auto_reload_consecutive_failures ?? 0) + 1;
    const shouldDisable = next >= MAX_AUTO_RELOAD_FAILURES;

    await ctx.db.patch(row._id, {
      auto_reload_consecutive_failures: next,
      ...(shouldDisable
        ? {
            auto_reload_enabled: false,
            auto_reload_disabled_reason: args.failureReason ?? "payment_failed",
          }
        : {}),
      updated_at: Date.now(),
    });

    convexLogger.info("team_auto_reload_outcome", {
      organization_id: args.organizationId,
      success: false,
      failure_reason: args.failureReason,
      consecutive_failures: next,
      auto_reload_disabled: shouldDisable,
    });

    return { autoReloadDisabled: shouldDisable, consecutiveFailures: next };
  },
});
