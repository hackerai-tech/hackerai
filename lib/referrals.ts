import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { phLogger } from "@/lib/posthog/server";
export {
  REFERRAL_COOKIE_MAX_AGE_SECONDS,
  REFERRAL_COOKIE_NAME,
  REFERRED_STARTER_CREDITS,
  REFERRER_CONVERSION_CREDITS,
} from "@/lib/referral-constants";

export type ReferralCookiePayload = {
  code: string;
  landingPath: string;
  viewedAt: number;
};

export type ReferralAttribution = {
  referralId: string;
  referrerUserId: string;
  referredUserId: string;
  referralCode: string;
  referralLandingPath?: string;
  status: string;
};

export function encodeReferralCookie(payload: ReferralCookiePayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeReferralCookie(
  value: string | undefined,
): ReferralCookiePayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<ReferralCookiePayload>;
    if (
      typeof parsed.code !== "string" ||
      parsed.code.length === 0 ||
      typeof parsed.landingPath !== "string" ||
      typeof parsed.viewedAt !== "number"
    ) {
      return null;
    }
    return {
      code: parsed.code.toUpperCase(),
      landingPath: parsed.landingPath,
      viewedAt: parsed.viewedAt,
    };
  } catch {
    return null;
  }
}

export async function spendReferralCreditsForFreeUsage(args: {
  userId: string;
  amountCredits: number;
  idempotencyKey: string;
}): Promise<boolean> {
  try {
    const convex = getConvexClient();
    const result = await convex.mutation(api.referrals.spendReferralCredits, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      userId: args.userId,
      amountCredits: args.amountCredits,
      idempotencyKey: args.idempotencyKey,
    });
    return result.success || result.alreadyProcessed;
  } catch (error) {
    phLogger.warn("referral_credit_spend_failed", {
      userId: args.userId,
      amount_credits: args.amountCredits,
      error,
    });
    return false;
  }
}

export async function getReferralAttribution(
  userId: string,
): Promise<ReferralAttribution | null> {
  try {
    const convex = getConvexClient();
    return await convex.query(api.referrals.getReferralAttributionForUser, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      userId,
    });
  } catch (error) {
    phLogger.warn("referral_attribution_lookup_failed", { userId, error });
    return null;
  }
}

export async function markReferralActivation(userId: string): Promise<void> {
  try {
    const convex = getConvexClient();
    const result = await convex.mutation(api.referrals.markReferralActivation, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      userId,
    });
    if (result.activated) {
      phLogger.event("referral_activation_completed", {
        userId,
        referrer_user_id: result.referrerUserId,
        referral_code: result.referralCode,
      });
    }
  } catch (error) {
    phLogger.warn("referral_activation_mark_failed", { userId, error });
  }
}

export async function awardReferralConversion(args: {
  referredUserId: string;
  qualifyingTier: string;
  idempotencyKey: string;
  revenueDollars?: number;
  stripeInvoiceId?: string;
  stripeSubscriptionId?: string;
}): Promise<void> {
  try {
    const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
    if (!serviceKey) {
      throw new Error("Missing server configuration: CONVEX_SERVICE_ROLE_KEY");
    }

    const convex = getConvexClient();
    const result = await convex.mutation(
      api.referrals.awardReferralConversion,
      {
        serviceKey,
        referredUserId: args.referredUserId,
        qualifyingTier: args.qualifyingTier,
        idempotencyKey: args.idempotencyKey,
      },
    );

    if (!result.awarded) return;

    phLogger.event("referral_conversion_completed", {
      userId: args.referredUserId,
      referrer_user_id: result.referrerUserId,
      referral_code: result.referralCode,
      qualifying_tier: args.qualifyingTier,
      revenue_dollars: args.revenueDollars,
      stripe_invoice_id: args.stripeInvoiceId,
      stripe_subscription_id: args.stripeSubscriptionId,
    });
    phLogger.event("referral_reward_credited", {
      userId: result.referrerUserId,
      referred_user_id: args.referredUserId,
      referral_code: result.referralCode,
      credits_awarded: result.creditsAwarded,
      reward_reason: "referrer_conversion_bonus",
    });
  } catch (error) {
    phLogger.warn("referral_conversion_award_failed", {
      userId: args.referredUserId,
      qualifying_tier: args.qualifyingTier,
      error,
    });
    throw error;
  }
}
