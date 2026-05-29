import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";
import { convexLogger } from "./lib/logger";

const POINTS_PER_DOLLAR = 10_000;

const paidTierValidator = v.union(
  v.literal("pro"),
  v.literal("pro-plus"),
  v.literal("ultra"),
  v.literal("team"),
);

type PaidTier = "pro" | "pro-plus" | "ultra" | "team";
type RewardType = "referred_signup" | "referrer_conversion";

const QUALIFYING_TIERS = new Set<PaidTier>([
  "pro",
  "pro-plus",
  "ultra",
  "team",
]);

const SUBSCRIPTION_ENDED_REASON = "subscription_ended";

const dollarsToPoints = (dollars: number): number =>
  Math.round(dollars * POINTS_PER_DOLLAR);

const pointsToDollars = (points: number): number => points / POINTS_PER_DOLLAR;

async function getReferralStats(ctx: QueryCtx | MutationCtx, userId: string) {
  const attributions = await ctx.db
    .query("referral_attributions")
    .withIndex("by_referrer_user_id", (q) => q.eq("referrer_user_id", userId))
    .take(5000);

  const rewards = await ctx.db
    .query("referral_rewards")
    .withIndex("by_referrer_user_id", (q) => q.eq("referrer_user_id", userId))
    .take(5000);

  return {
    attributedSignups: attributions.length,
    paidConversions: attributions.filter(
      (row) => row.conversion_reward_status === "awarded",
    ).length,
    awardedDollars: rewards
      .filter(
        (row) =>
          row.status === "awarded" && row.reward_type === "referrer_conversion",
      )
      .reduce((sum, row) => sum + row.amount_dollars, 0),
  };
}

async function ensurePersonalExtraUsageEnabled(
  ctx: MutationCtx,
  userId: string,
  now: number,
) {
  const customization = await ctx.db
    .query("user_customization")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .first();

  if (customization) {
    if (!customization.extra_usage_enabled) {
      await ctx.db.patch(customization._id, {
        extra_usage_enabled: true,
        updated_at: now,
      });
    }
    return;
  }

  await ctx.db.insert("user_customization", {
    user_id: userId,
    extra_usage_enabled: true,
    updated_at: now,
  });
}

async function addPersonalCredits(
  ctx: MutationCtx,
  userId: string,
  amountDollars: number,
  now: number,
) {
  const amountPoints = dollarsToPoints(amountDollars);
  const row = await ctx.db
    .query("extra_usage")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .first();

  const newBalancePoints = (row?.balance_points ?? 0) + amountPoints;
  if (row) {
    await ctx.db.patch(row._id, {
      balance_points: newBalancePoints,
      updated_at: now,
    });
  } else {
    await ctx.db.insert("extra_usage", {
      user_id: userId,
      balance_points: newBalancePoints,
      updated_at: now,
    });
  }

  await ensurePersonalExtraUsageEnabled(ctx, userId, now);
  return pointsToDollars(newBalancePoints);
}

async function addTeamCredits(
  ctx: MutationCtx,
  organizationId: string,
  amountDollars: number,
  now: number,
) {
  const amountPoints = dollarsToPoints(amountDollars);
  const row = await ctx.db
    .query("team_extra_usage")
    .withIndex("by_org", (q) => q.eq("organization_id", organizationId))
    .first();

  const newBalancePoints = (row?.balance_points ?? 0) + amountPoints;
  if (row) {
    await ctx.db.patch(row._id, {
      enabled: true,
      balance_points: newBalancePoints,
      updated_at: now,
    });
  } else {
    await ctx.db.insert("team_extra_usage", {
      organization_id: organizationId,
      enabled: true,
      balance_points: newBalancePoints,
      updated_at: now,
    });
  }

  return pointsToDollars(newBalancePoints);
}

async function insertRewardLog(
  ctx: MutationCtx,
  args: {
    idempotencyKey: string;
    rewardType: RewardType;
    status: "awarded" | "withheld";
    amountDollars: number;
    amountUnits?: number;
    reason?: string;
    userId?: string;
    referrerUserId?: string;
    referredUserId?: string;
    referralCode?: string;
    stripeCheckoutSessionId?: string;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    stripeInvoiceId?: string;
  },
) {
  const existing = await ctx.db
    .query("referral_rewards")
    .withIndex("by_idempotency_key", (q) =>
      q.eq("idempotency_key", args.idempotencyKey),
    )
    .first();

  if (existing) return { alreadyProcessed: true };

  await ctx.db.insert("referral_rewards", {
    idempotency_key: args.idempotencyKey,
    reward_type: args.rewardType,
    status: args.status,
    amount_dollars: args.amountDollars,
    amount_units: args.amountUnits,
    user_id: args.userId,
    referrer_user_id: args.referrerUserId,
    referred_user_id: args.referredUserId,
    referral_code: args.referralCode,
    reason: args.reason,
    stripe_checkout_session_id: args.stripeCheckoutSessionId,
    stripe_customer_id: args.stripeCustomerId,
    stripe_subscription_id: args.stripeSubscriptionId,
    stripe_invoice_id: args.stripeInvoiceId,
    created_at: Date.now(),
  });

  return { alreadyProcessed: false };
}

async function grantReward(
  ctx: MutationCtx,
  args: {
    idempotencyKey: string;
    rewardType: RewardType;
    userId: string;
    amountDollars: number;
    referrerUserId?: string;
    referredUserId?: string;
    referralCode?: string;
    subscriptionTier?: PaidTier;
    organizationId?: string;
    stripeCheckoutSessionId?: string;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    stripeInvoiceId?: string;
  },
) {
  if (!Number.isFinite(args.amountDollars) || args.amountDollars <= 0) {
    return { alreadyProcessed: false, newBalance: 0 };
  }

  const existing = await ctx.db
    .query("referral_rewards")
    .withIndex("by_idempotency_key", (q) =>
      q.eq("idempotency_key", args.idempotencyKey),
    )
    .first();

  if (existing) {
    return { alreadyProcessed: true, newBalance: 0 };
  }

  const now = Date.now();
  const newBalance =
    args.subscriptionTier === "team" && args.organizationId
      ? await addTeamCredits(ctx, args.organizationId, args.amountDollars, now)
      : await addPersonalCredits(ctx, args.userId, args.amountDollars, now);

  await insertRewardLog(ctx, {
    idempotencyKey: args.idempotencyKey,
    rewardType: args.rewardType,
    status: "awarded",
    amountDollars: args.amountDollars,
    userId: args.userId,
    referrerUserId: args.referrerUserId,
    referredUserId: args.referredUserId,
    referralCode: args.referralCode,
    stripeCheckoutSessionId: args.stripeCheckoutSessionId,
    stripeCustomerId: args.stripeCustomerId,
    stripeSubscriptionId: args.stripeSubscriptionId,
    stripeInvoiceId: args.stripeInvoiceId,
  });

  convexLogger.info("referral_reward_awarded", {
    reward_type: args.rewardType,
    user_id: args.userId,
    referrer_user_id: args.referrerUserId,
    referred_user_id: args.referredUserId,
    referral_code: args.referralCode,
    amount_dollars: args.amountDollars,
    idempotency_key: args.idempotencyKey,
  });

  return { alreadyProcessed: false, newBalance };
}

export const getOrCreateReferralCode = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    subscriptionTier: paidTierValidator,
    organizationId: v.optional(v.string()),
    codeCandidate: v.string(),
  },
  returns: v.object({
    code: v.string(),
    active: v.boolean(),
    attributedSignups: v.number(),
    paidConversions: v.number(),
    awardedDollars: v.number(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const now = Date.now();
    const existingForUser = await ctx.db
      .query("referral_codes")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .first();

    if (existingForUser) {
      const canBeActive =
        existingForUser.status === "active" ||
        existingForUser.deactivated_reason === SUBSCRIPTION_ENDED_REASON;

      await ctx.db.patch(existingForUser._id, {
        status: canBeActive ? "active" : existingForUser.status,
        referrer_subscription_tier: args.subscriptionTier,
        referrer_organization_id: args.organizationId,
        updated_at: now,
      });
      return {
        code: existingForUser.code,
        active: canBeActive,
        ...(await getReferralStats(ctx, args.userId)),
      };
    }

    const existingForCode = await ctx.db
      .query("referral_codes")
      .withIndex("by_code", (q) => q.eq("code", args.codeCandidate))
      .first();

    if (existingForCode) {
      throw new Error("Referral code collision");
    }

    await ctx.db.insert("referral_codes", {
      user_id: args.userId,
      code: args.codeCandidate,
      status: "active",
      referrer_subscription_tier: args.subscriptionTier,
      referrer_organization_id: args.organizationId,
      created_at: now,
      updated_at: now,
    });

    return {
      code: args.codeCandidate,
      active: true,
      ...(await getReferralStats(ctx, args.userId)),
    };
  },
});

export const getReferralInvite = query({
  args: {
    serviceKey: v.string(),
    referralCode: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      code: v.string(),
      active: v.boolean(),
      referrerUserId: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const referralCode = await ctx.db
      .query("referral_codes")
      .withIndex("by_code", (q) => q.eq("code", args.referralCode))
      .first();

    if (!referralCode) return null;

    return {
      code: referralCode.code,
      active: referralCode.status === "active",
      referrerUserId: referralCode.user_id,
    };
  },
});

export const setReferralCodesPaidEligibility = mutation({
  args: {
    serviceKey: v.string(),
    userIds: v.array(v.string()),
    active: v.boolean(),
    subscriptionTier: v.optional(paidTierValidator),
    organizationId: v.optional(v.string()),
  },
  returns: v.object({
    updated: v.number(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const now = Date.now();
    let updated = 0;

    for (const userId of new Set(args.userIds)) {
      const referralCode = await ctx.db
        .query("referral_codes")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .first();

      if (!referralCode) continue;

      if (args.active) {
        const canReactivate =
          referralCode.status === "active" ||
          referralCode.deactivated_reason === SUBSCRIPTION_ENDED_REASON;

        if (!canReactivate) continue;

        await ctx.db.patch(referralCode._id, {
          status: "active",
          referrer_subscription_tier:
            args.subscriptionTier ?? referralCode.referrer_subscription_tier,
          referrer_organization_id:
            args.organizationId ?? referralCode.referrer_organization_id,
          updated_at: now,
        });
        updated += 1;
        continue;
      }

      if (referralCode.status !== "active") continue;

      await ctx.db.patch(referralCode._id, {
        status: "deactivated",
        deactivated_at: now,
        deactivated_reason: SUBSCRIPTION_ENDED_REASON,
        updated_at: now,
      });
      updated += 1;
    }

    return { updated };
  },
});

export const attributeReferredSignup = mutation({
  args: {
    serviceKey: v.string(),
    referredUserId: v.string(),
    referralCode: v.string(),
    starterBonusUnits: v.number(),
    userCreatedAtMs: v.optional(v.number()),
    maxUserAgeDays: v.optional(v.number()),
    source: v.optional(v.string()),
  },
  returns: v.object({
    status: v.union(
      v.literal("attributed"),
      v.literal("already_attributed"),
      v.literal("blocked"),
      v.literal("not_found"),
    ),
    reason: v.optional(v.string()),
    referrerUserId: v.optional(v.string()),
    starterBonusAwarded: v.boolean(),
    starterBonusEligible: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const now = Date.now();
    const starterBonusUnits = Math.max(0, Math.trunc(args.starterBonusUnits));
    const existing = await ctx.db
      .query("referral_attributions")
      .withIndex("by_referred_user_id", (q) =>
        q.eq("referred_user_id", args.referredUserId),
      )
      .first();

    if (existing) {
      return {
        status: "already_attributed" as const,
        referrerUserId: existing.referrer_user_id,
        starterBonusAwarded: existing.sign_up_reward_status === "awarded",
        starterBonusEligible:
          existing.sign_up_reward_status === "none" && starterBonusUnits > 0,
      };
    }

    const referralCode = await ctx.db
      .query("referral_codes")
      .withIndex("by_code", (q) => q.eq("code", args.referralCode))
      .first();

    if (!referralCode || referralCode.status !== "active") {
      await insertRewardLog(ctx, {
        idempotencyKey: `referral_signup_blocked:${args.referredUserId}:${args.referralCode}`,
        rewardType: "referred_signup",
        status: "withheld",
        amountDollars: 0,
        referredUserId: args.referredUserId,
        referralCode: args.referralCode,
        reason: "invalid_or_inactive_referral_code",
      });
      return {
        status: "not_found" as const,
        reason: "invalid_or_inactive_referral_code",
        starterBonusAwarded: false,
        starterBonusEligible: false,
      };
    }

    if (referralCode.user_id === args.referredUserId) {
      await insertRewardLog(ctx, {
        idempotencyKey: `referral_signup_blocked:${args.referredUserId}:self`,
        rewardType: "referred_signup",
        status: "withheld",
        amountDollars: 0,
        referrerUserId: referralCode.user_id,
        referredUserId: args.referredUserId,
        referralCode: referralCode.code,
        reason: "self_referral",
      });
      return {
        status: "blocked" as const,
        reason: "self_referral",
        referrerUserId: referralCode.user_id,
        starterBonusAwarded: false,
        starterBonusEligible: false,
      };
    }

    if (
      args.userCreatedAtMs &&
      args.maxUserAgeDays != null &&
      args.maxUserAgeDays >= 0
    ) {
      const maxAgeMs = args.maxUserAgeDays * 24 * 60 * 60 * 1000;
      if (now - args.userCreatedAtMs > maxAgeMs) {
        await insertRewardLog(ctx, {
          idempotencyKey: `referral_signup_blocked:${args.referredUserId}:existing_user`,
          rewardType: "referred_signup",
          status: "withheld",
          amountDollars: 0,
          referrerUserId: referralCode.user_id,
          referredUserId: args.referredUserId,
          referralCode: referralCode.code,
          reason: "existing_user",
        });
        return {
          status: "blocked" as const,
          reason: "existing_user",
          referrerUserId: referralCode.user_id,
          starterBonusAwarded: false,
          starterBonusEligible: false,
        };
      }
    }

    await ctx.db.insert("referral_attributions", {
      referred_user_id: args.referredUserId,
      referrer_user_id: referralCode.user_id,
      referral_code: referralCode.code,
      referrer_subscription_tier: referralCode.referrer_subscription_tier,
      referrer_organization_id: referralCode.referrer_organization_id,
      status: "attributed",
      sign_up_reward_status: "none",
      conversion_reward_status: "pending",
      source: args.source,
      created_at: now,
      updated_at: now,
    });

    convexLogger.info("referral_signup_attributed", {
      referrer_user_id: referralCode.user_id,
      referred_user_id: args.referredUserId,
      referral_code: referralCode.code,
      starter_bonus_units: starterBonusUnits,
    });

    return {
      status: "attributed" as const,
      referrerUserId: referralCode.user_id,
      starterBonusAwarded: false,
      starterBonusEligible: starterBonusUnits > 0,
    };
  },
});

export const markReferredSignupBonusGranted = mutation({
  args: {
    serviceKey: v.string(),
    referredUserId: v.string(),
    referralCode: v.string(),
    amountUnits: v.number(),
  },
  returns: v.object({
    awarded: v.boolean(),
    alreadyAwarded: v.boolean(),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const amountUnits = Math.max(0, Math.trunc(args.amountUnits));
    if (amountUnits <= 0) {
      return { awarded: false, alreadyAwarded: false, reason: "no_bonus" };
    }

    const attribution = await ctx.db
      .query("referral_attributions")
      .withIndex("by_referred_user_id", (q) =>
        q.eq("referred_user_id", args.referredUserId),
      )
      .first();

    if (!attribution || attribution.referral_code !== args.referralCode) {
      return {
        awarded: false,
        alreadyAwarded: false,
        reason: "attribution_not_found",
      };
    }

    if (attribution.sign_up_reward_status === "awarded") {
      return { awarded: true, alreadyAwarded: true };
    }

    if (attribution.sign_up_reward_status === "withheld") {
      return {
        awarded: false,
        alreadyAwarded: false,
        reason: attribution.withheld_reason ?? "withheld",
      };
    }

    const reward = await insertRewardLog(ctx, {
      idempotencyKey: `referral_signup:${args.referredUserId}`,
      rewardType: "referred_signup",
      status: "awarded",
      amountDollars: 0,
      amountUnits,
      userId: args.referredUserId,
      referrerUserId: attribution.referrer_user_id,
      referredUserId: args.referredUserId,
      referralCode: attribution.referral_code,
    });

    await ctx.db.patch(attribution._id, {
      sign_up_reward_status: "awarded",
      updated_at: Date.now(),
    });

    convexLogger.info("referral_signup_bonus_granted", {
      referrer_user_id: attribution.referrer_user_id,
      referred_user_id: args.referredUserId,
      referral_code: attribution.referral_code,
      amount_units: amountUnits,
    });

    return { awarded: true, alreadyAwarded: reward.alreadyProcessed };
  },
});

export const recordReferralCheckoutSession = mutation({
  args: {
    serviceKey: v.string(),
    referredUserId: v.string(),
    stripeCustomerId: v.string(),
    stripeCheckoutSessionId: v.string(),
    stripeSubscriptionId: v.optional(v.string()),
    requestedPlan: v.string(),
  },
  returns: v.object({
    recorded: v.boolean(),
    referralCode: v.optional(v.string()),
    referrerUserId: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const attribution = await ctx.db
      .query("referral_attributions")
      .withIndex("by_referred_user_id", (q) =>
        q.eq("referred_user_id", args.referredUserId),
      )
      .first();

    if (!attribution) return { recorded: false };

    await ctx.db.patch(attribution._id, {
      stripe_customer_id: args.stripeCustomerId,
      stripe_checkout_session_id: args.stripeCheckoutSessionId,
      stripe_subscription_id:
        args.stripeSubscriptionId ?? attribution.stripe_subscription_id,
      requested_plan: args.requestedPlan,
      updated_at: Date.now(),
    });

    return {
      recorded: true,
      referralCode: attribution.referral_code,
      referrerUserId: attribution.referrer_user_id,
    };
  },
});

export const awardConversionReward = mutation({
  args: {
    serviceKey: v.string(),
    referrerRewardDollars: v.number(),
    referredUserId: v.optional(v.string()),
    stripeCheckoutSessionId: v.optional(v.string()),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    stripeInvoiceId: v.optional(v.string()),
    plan: v.optional(v.string()),
    tier: v.optional(paidTierValidator),
  },
  returns: v.object({
    status: v.union(
      v.literal("awarded"),
      v.literal("already_awarded"),
      v.literal("withheld"),
      v.literal("no_attribution"),
    ),
    reason: v.optional(v.string()),
    referrerUserId: v.optional(v.string()),
    referredUserId: v.optional(v.string()),
    referralCode: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    let attribution = args.referredUserId
      ? await ctx.db
          .query("referral_attributions")
          .withIndex("by_referred_user_id", (q) =>
            q.eq("referred_user_id", args.referredUserId!),
          )
          .first()
      : null;

    if (!attribution && args.stripeSubscriptionId) {
      attribution = await ctx.db
        .query("referral_attributions")
        .withIndex("by_stripe_subscription_id", (q) =>
          q.eq("stripe_subscription_id", args.stripeSubscriptionId),
        )
        .order("desc")
        .first();
    }

    if (!attribution && args.stripeCheckoutSessionId) {
      attribution = await ctx.db
        .query("referral_attributions")
        .withIndex("by_stripe_checkout_session_id", (q) =>
          q.eq("stripe_checkout_session_id", args.stripeCheckoutSessionId),
        )
        .order("desc")
        .first();
    }

    if (!attribution && args.stripeCustomerId) {
      attribution = await ctx.db
        .query("referral_attributions")
        .withIndex("by_stripe_customer_id", (q) =>
          q.eq("stripe_customer_id", args.stripeCustomerId),
        )
        .order("desc")
        .first();
    }

    if (!attribution) {
      return { status: "no_attribution" as const };
    }

    const now = Date.now();
    await ctx.db.patch(attribution._id, {
      stripe_checkout_session_id:
        args.stripeCheckoutSessionId ?? attribution.stripe_checkout_session_id,
      stripe_customer_id:
        args.stripeCustomerId ?? attribution.stripe_customer_id,
      stripe_subscription_id:
        args.stripeSubscriptionId ?? attribution.stripe_subscription_id,
      stripe_invoice_id: args.stripeInvoiceId ?? attribution.stripe_invoice_id,
      requested_plan: args.plan ?? attribution.requested_plan,
      converted_tier: args.tier ?? attribution.converted_tier,
      updated_at: now,
    });

    if (attribution.conversion_reward_status === "awarded") {
      return {
        status: "already_awarded" as const,
        referrerUserId: attribution.referrer_user_id,
        referredUserId: attribution.referred_user_id,
        referralCode: attribution.referral_code,
      };
    }

    if (attribution.conversion_reward_status === "withheld") {
      return {
        status: "withheld" as const,
        reason: attribution.withheld_reason,
        referrerUserId: attribution.referrer_user_id,
        referredUserId: attribution.referred_user_id,
        referralCode: attribution.referral_code,
      };
    }

    if (!args.tier || !QUALIFYING_TIERS.has(args.tier)) {
      await ctx.db.patch(attribution._id, {
        conversion_reward_status: "withheld",
        withheld_reason: "non_qualifying_plan",
        updated_at: Date.now(),
      });
      await insertRewardLog(ctx, {
        idempotencyKey: `referral_conversion_withheld:${attribution._id}:non_qualifying_plan`,
        rewardType: "referrer_conversion",
        status: "withheld",
        amountDollars: 0,
        referrerUserId: attribution.referrer_user_id,
        referredUserId: attribution.referred_user_id,
        referralCode: attribution.referral_code,
        stripeCheckoutSessionId: args.stripeCheckoutSessionId,
        stripeCustomerId: args.stripeCustomerId,
        stripeSubscriptionId: args.stripeSubscriptionId,
        stripeInvoiceId: args.stripeInvoiceId,
        reason: "non_qualifying_plan",
      });
      return {
        status: "withheld" as const,
        reason: "non_qualifying_plan",
        referrerUserId: attribution.referrer_user_id,
        referredUserId: attribution.referred_user_id,
        referralCode: attribution.referral_code,
      };
    }

    const referralCode = await ctx.db
      .query("referral_codes")
      .withIndex("by_code", (q) => q.eq("code", attribution.referral_code))
      .first();

    if (!referralCode || referralCode.status !== "active") {
      await ctx.db.patch(attribution._id, {
        conversion_reward_status: "withheld",
        withheld_reason: "referrer_not_paid",
        updated_at: Date.now(),
      });
      await insertRewardLog(ctx, {
        idempotencyKey: `referral_conversion_withheld:${attribution._id}:referrer_not_paid`,
        rewardType: "referrer_conversion",
        status: "withheld",
        amountDollars: 0,
        referrerUserId: attribution.referrer_user_id,
        referredUserId: attribution.referred_user_id,
        referralCode: attribution.referral_code,
        stripeCheckoutSessionId: args.stripeCheckoutSessionId,
        stripeCustomerId: args.stripeCustomerId,
        stripeSubscriptionId: args.stripeSubscriptionId,
        stripeInvoiceId: args.stripeInvoiceId,
        reason: "referrer_not_paid",
      });
      return {
        status: "withheld" as const,
        reason: "referrer_not_paid",
        referrerUserId: attribution.referrer_user_id,
        referredUserId: attribution.referred_user_id,
        referralCode: attribution.referral_code,
      };
    }

    const reward = await grantReward(ctx, {
      idempotencyKey: `referral_conversion:${attribution._id}`,
      rewardType: "referrer_conversion",
      userId: attribution.referrer_user_id,
      amountDollars: args.referrerRewardDollars,
      referrerUserId: attribution.referrer_user_id,
      referredUserId: attribution.referred_user_id,
      referralCode: attribution.referral_code,
      subscriptionTier: attribution.referrer_subscription_tier,
      organizationId: attribution.referrer_organization_id,
      stripeCheckoutSessionId: args.stripeCheckoutSessionId,
      stripeCustomerId: args.stripeCustomerId,
      stripeSubscriptionId: args.stripeSubscriptionId,
      stripeInvoiceId: args.stripeInvoiceId,
    });

    await ctx.db.patch(attribution._id, {
      status: "converted",
      conversion_reward_status: "awarded",
      converted_at: Date.now(),
      updated_at: Date.now(),
    });

    return {
      status: reward.alreadyProcessed
        ? ("already_awarded" as const)
        : ("awarded" as const),
      referrerUserId: attribution.referrer_user_id,
      referredUserId: attribution.referred_user_id,
      referralCode: attribution.referral_code,
    };
  },
});
