import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";

export const REFERRAL_STARTER_CREDITS = 10;
export const REFERRER_CONVERSION_CREDITS = 10;
export const REFERRAL_REWARD_EXPERIMENT_FLAG = "referral_reward_experiment";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REFERRAL_CODE_LENGTH = 8;
const MAX_REFERRAL_SUMMARY_ROWS = 1000;

type ReferralStatus = "signed_up" | "activated" | "converted";
type LedgerReason =
  | "referred_signup_bonus"
  | "referrer_conversion_bonus"
  | "free_usage_overflow";

function generateReferralCode(): string {
  let code = "";
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

async function requireAuthenticatedUserId(ctx: any): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Unauthorized");
  }
  return identity.subject;
}

async function getOrCreateBalance(ctx: any, userId: string, now: number) {
  const existing = await ctx.db
    .query("referral_credit_balances")
    .withIndex("by_user", (q: any) => q.eq("user_id", userId))
    .unique();

  if (existing) return existing;

  const id = await ctx.db.insert("referral_credit_balances", {
    user_id: userId,
    balance_credits: 0,
    updated_at: now,
  });
  return ctx.db.get(id);
}

async function insertLedgerEntry(
  ctx: any,
  args: {
    userId: string;
    amountCredits: number;
    type: "grant" | "spend";
    reason: LedgerReason;
    idempotencyKey: string;
    relatedReferralId?: string;
  },
) {
  const existing = await ctx.db
    .query("referral_credit_ledger")
    .withIndex("by_idempotency_key", (q: any) =>
      q.eq("idempotency_key", args.idempotencyKey),
    )
    .unique();

  if (existing) return { alreadyProcessed: true, ledger: existing };

  const now = Date.now();
  const balance = await getOrCreateBalance(ctx, args.userId, now);
  const currentBalance = balance?.balance_credits ?? 0;
  const nextBalance = currentBalance + args.amountCredits;

  if (nextBalance < 0) {
    return { alreadyProcessed: false, insufficientCredits: true };
  }

  await ctx.db.patch(balance._id, {
    balance_credits: nextBalance,
    updated_at: now,
  });

  const ledgerId = await ctx.db.insert("referral_credit_ledger", {
    user_id: args.userId,
    amount_credits: args.amountCredits,
    type: args.type,
    reason: args.reason,
    idempotency_key: args.idempotencyKey,
    related_referral_id: args.relatedReferralId,
    created_at: now,
  });

  return {
    alreadyProcessed: false,
    insufficientCredits: false,
    ledger: await ctx.db.get(ledgerId),
    newBalanceCredits: nextBalance,
  };
}

export const getOrCreateReferralCode = mutation({
  args: {},
  returns: v.object({ code: v.string() }),
  handler: async (ctx) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const existing = await ctx.db
      .query("referral_codes")
      .withIndex("by_user", (q) => q.eq("user_id", userId))
      .unique();

    if (existing) return { code: existing.code };

    for (let attempts = 0; attempts < 10; attempts++) {
      const code = generateReferralCode();
      const collision = await ctx.db
        .query("referral_codes")
        .withIndex("by_code", (q) => q.eq("code", code))
        .unique();
      if (collision) continue;

      await ctx.db.insert("referral_codes", {
        user_id: userId,
        code,
        created_at: Date.now(),
      });
      return { code };
    }

    throw new Error("Unable to generate referral code");
  },
});

export const getReferralCode = query({
  args: { code: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      code: v.string(),
      referrerUserId: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("referral_codes")
      .withIndex("by_code", (q) => q.eq("code", args.code.toUpperCase()))
      .unique();

    if (!row) return null;

    return {
      code: row.code,
      referrerUserId: row.user_id,
    };
  },
});

export const getReferralSummary = query({
  args: {},
  returns: v.object({
    code: v.optional(v.string()),
    balanceCredits: v.number(),
    signedUp: v.number(),
    activated: v.number(),
    converted: v.number(),
  }),
  handler: async (ctx) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const [codeRow, balanceRow, referrals] = await Promise.all([
      ctx.db
        .query("referral_codes")
        .withIndex("by_user", (q) => q.eq("user_id", userId))
        .unique(),
      ctx.db
        .query("referral_credit_balances")
        .withIndex("by_user", (q) => q.eq("user_id", userId))
        .unique(),
      ctx.db
        .query("referrals")
        .withIndex("by_referrer", (q) => q.eq("referrer_user_id", userId))
        .take(MAX_REFERRAL_SUMMARY_ROWS),
    ]);

    return {
      code: codeRow?.code,
      balanceCredits: balanceRow?.balance_credits ?? 0,
      signedUp: referrals.length,
      activated: referrals.filter(
        (r) => r.status === "activated" || r.status === "converted",
      ).length,
      converted: referrals.filter((r) => r.status === "converted").length,
    };
  },
});

export const getReferralAttributionForUser = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      referralId: v.id("referrals"),
      referrerUserId: v.string(),
      referredUserId: v.string(),
      referralCode: v.string(),
      referralLandingPath: v.optional(v.string()),
      status: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const referral = await ctx.db
      .query("referrals")
      .withIndex("by_referred_user", (q) =>
        q.eq("referred_user_id", args.userId),
      )
      .unique();

    if (!referral) return null;

    return {
      referralId: referral._id,
      referrerUserId: referral.referrer_user_id,
      referredUserId: referral.referred_user_id,
      referralCode: referral.referral_code,
      referralLandingPath: referral.referral_landing_path,
      status: referral.status,
    };
  },
});

export const claimReferralSignup = mutation({
  args: {
    serviceKey: v.string(),
    referredUserId: v.string(),
    referralCode: v.string(),
    referralLandingPath: v.optional(v.string()),
  },
  returns: v.object({
    claimed: v.boolean(),
    reason: v.optional(v.string()),
    referrerUserId: v.optional(v.string()),
    referralCode: v.optional(v.string()),
    starterCreditsAwarded: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const codeRow = await ctx.db
      .query("referral_codes")
      .withIndex("by_code", (q) =>
        q.eq("code", args.referralCode.toUpperCase()),
      )
      .unique();

    if (!codeRow) return { claimed: false, reason: "invalid_code" };

    if (codeRow.user_id === args.referredUserId) {
      return { claimed: false, reason: "self_referral" };
    }

    const existing = await ctx.db
      .query("referrals")
      .withIndex("by_referred_user", (q) =>
        q.eq("referred_user_id", args.referredUserId),
      )
      .unique();

    if (existing) {
      return {
        claimed: false,
        reason: "already_claimed",
        referrerUserId: existing.referrer_user_id,
        referralCode: existing.referral_code,
      };
    }

    const now = Date.now();
    const referralId = await ctx.db.insert("referrals", {
      referrer_user_id: codeRow.user_id,
      referred_user_id: args.referredUserId,
      referral_code: codeRow.code,
      referral_landing_path: args.referralLandingPath,
      status: "signed_up" as ReferralStatus,
      signed_up_at: now,
      updated_at: now,
    });

    await insertLedgerEntry(ctx, {
      userId: args.referredUserId,
      amountCredits: REFERRAL_STARTER_CREDITS,
      type: "grant",
      reason: "referred_signup_bonus",
      idempotencyKey: `referral_signup:${args.referredUserId}`,
      relatedReferralId: referralId,
    });

    return {
      claimed: true,
      referrerUserId: codeRow.user_id,
      referralCode: codeRow.code,
      starterCreditsAwarded: REFERRAL_STARTER_CREDITS,
    };
  },
});

export const markReferralActivation = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
  },
  returns: v.object({
    activated: v.boolean(),
    referrerUserId: v.optional(v.string()),
    referralCode: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const referral = await ctx.db
      .query("referrals")
      .withIndex("by_referred_user", (q) =>
        q.eq("referred_user_id", args.userId),
      )
      .unique();

    if (!referral) return { activated: false };
    if (referral.activated_at || referral.status === "converted") {
      return {
        activated: false,
        referrerUserId: referral.referrer_user_id,
        referralCode: referral.referral_code,
      };
    }

    await ctx.db.patch(referral._id, {
      status: "activated" as ReferralStatus,
      activated_at: Date.now(),
      updated_at: Date.now(),
    });

    return {
      activated: true,
      referrerUserId: referral.referrer_user_id,
      referralCode: referral.referral_code,
    };
  },
});

export const awardReferralConversion = mutation({
  args: {
    serviceKey: v.string(),
    referredUserId: v.string(),
    qualifyingTier: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.object({
    awarded: v.boolean(),
    reason: v.optional(v.string()),
    referrerUserId: v.optional(v.string()),
    referralCode: v.optional(v.string()),
    creditsAwarded: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const referral = await ctx.db
      .query("referrals")
      .withIndex("by_referred_user", (q) =>
        q.eq("referred_user_id", args.referredUserId),
      )
      .unique();

    if (!referral) return { awarded: false, reason: "no_referral" };
    if (referral.converted_at) {
      return {
        awarded: false,
        reason: "already_converted",
        referrerUserId: referral.referrer_user_id,
        referralCode: referral.referral_code,
      };
    }

    const ledger = await insertLedgerEntry(ctx, {
      userId: referral.referrer_user_id,
      amountCredits: REFERRER_CONVERSION_CREDITS,
      type: "grant",
      reason: "referrer_conversion_bonus",
      idempotencyKey: `referral_conversion:${args.referredUserId}`,
      relatedReferralId: referral._id,
    });

    if (ledger.alreadyProcessed) {
      return {
        awarded: false,
        reason: "already_awarded",
        referrerUserId: referral.referrer_user_id,
        referralCode: referral.referral_code,
      };
    }

    await ctx.db.patch(referral._id, {
      status: "converted" as ReferralStatus,
      converted_at: Date.now(),
      qualifying_tier: args.qualifyingTier,
      conversion_idempotency_key: args.idempotencyKey,
      updated_at: Date.now(),
    });

    return {
      awarded: true,
      referrerUserId: referral.referrer_user_id,
      referralCode: referral.referral_code,
      creditsAwarded: REFERRER_CONVERSION_CREDITS,
    };
  },
});

export const spendReferralCredits = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    amountCredits: v.number(),
    idempotencyKey: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    alreadyProcessed: v.boolean(),
    insufficientCredits: v.boolean(),
    newBalanceCredits: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (!Number.isFinite(args.amountCredits)) {
      throw new Error("amountCredits must be a finite positive number");
    }
    const amount = Math.trunc(args.amountCredits);
    if (amount < 1) {
      throw new Error("amountCredits must be at least 1");
    }

    const result = await insertLedgerEntry(ctx, {
      userId: args.userId,
      amountCredits: -amount,
      type: "spend",
      reason: "free_usage_overflow",
      idempotencyKey: args.idempotencyKey,
    });

    return {
      success: !result.insufficientCredits,
      alreadyProcessed: result.alreadyProcessed ?? false,
      insufficientCredits: result.insufficientCredits ?? false,
      newBalanceCredits: result.newBalanceCredits,
    };
  },
});
