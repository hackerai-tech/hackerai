import { after, NextRequest, NextResponse } from "next/server";
import { getConvexClient } from "@/lib/db/convex-client";
import { api } from "@/convex/_generated/api";
import { workos } from "@/app/api/workos";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import {
  REFERRAL_COOKIE_CREATED_AT_NAME,
  REFERRAL_COOKIE_NAME,
  getReferralRewardConfig,
  isValidReferralCode,
} from "@/lib/referrals/config";
import { grantFreeReferralBonusUnits } from "@/lib/rate-limit/sliding-window";
import { phLogger } from "@/lib/posthog/server";

export const runtime = "nodejs";

function clearReferralCookies(response: NextResponse) {
  response.cookies.delete(REFERRAL_COOKIE_NAME);
  response.cookies.delete(REFERRAL_COOKIE_CREATED_AT_NAME);
}

function parseCreatedAtMs(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export async function POST(req: NextRequest) {
  const config = getReferralRewardConfig();
  const referralCode = req.cookies.get(REFERRAL_COOKIE_NAME)?.value;

  if (!config.enabled || !referralCode) {
    return NextResponse.json({ attributed: false });
  }

  if (!isValidReferralCode(referralCode)) {
    const response = NextResponse.json({
      attributed: false,
      reason: "invalid_referral_code",
    });
    clearReferralCookies(response);
    return response;
  }

  const { userId, subscription, freeQuotaSubject } = await getUserIDAndPro(req);
  const freeUsageSubject = freeQuotaSubject ?? userId;
  if (subscription !== "free") {
    const response = NextResponse.json({
      attributed: false,
      reason: "existing_paid_user",
    });
    clearReferralCookies(response);
    return response;
  }

  const user = await workos.userManagement.getUser(userId);
  const result = await getConvexClient().mutation(
    api.referrals.attributeReferredSignup,
    {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      referredUserId: userId,
      referralCode,
      starterBonusUnits: config.referredSignupBonusUnits,
      referredIdentityHash: freeQuotaSubject,
      userCreatedAtMs: parseCreatedAtMs(user.createdAt),
      maxUserAgeDays: config.attributionMaxUserAgeDays,
      source: "referral_cookie",
    },
  );
  const referrerSubscriptionTier = (
    result as { referrerSubscriptionTier?: string }
  ).referrerSubscriptionTier;

  let starterBonusUnitsAwarded = false;
  let starterBonusUnits = 0;
  let starterBonusMarkedAwarded = result.starterBonusAwarded;

  if (
    (result.status === "attributed" ||
      result.status === "already_attributed") &&
    result.starterBonusEligible &&
    result.starterBonusUnits > 0
  ) {
    try {
      const grant = await grantFreeReferralBonusUnits(
        freeUsageSubject,
        result.starterBonusUnits,
        `referral_signup:${freeUsageSubject}`,
      );

      if (grant.granted || grant.alreadyGranted) {
        const marked = await getConvexClient().mutation(
          api.referrals.markReferredSignupBonusGranted,
          {
            serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
            referredUserId: userId,
          },
        );

        starterBonusMarkedAwarded = marked.awarded;
        starterBonusUnitsAwarded = grant.granted && marked.awarded;
        starterBonusUnits = starterBonusUnitsAwarded
          ? result.starterBonusUnits
          : 0;
      }

      if (!grant.granted && !grant.alreadyGranted) {
        phLogger.warn("referral_signup_bonus_grant_failed", {
          userId,
          referrer_user_id: result.referrerUserId,
          referrer_subscription_tier: referrerSubscriptionTier,
          referral_code: referralCode,
          starter_bonus_units: result.starterBonusUnits,
        });
      }
    } catch (error) {
      phLogger.warn("referral_signup_bonus_grant_failed", {
        userId,
        referrer_user_id: result.referrerUserId,
        referrer_subscription_tier: referrerSubscriptionTier,
        referral_code: referralCode,
        starter_bonus_units: result.starterBonusUnits,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (result.status === "attributed") {
    phLogger.event("referred_signup_attributed", {
      userId,
      referrer_user_id: result.referrerUserId,
      referrer_subscription_tier: referrerSubscriptionTier,
      referral_code: referralCode,
      starter_bonus_awarded: starterBonusUnitsAwarded,
      starter_bonus_units: starterBonusUnits,
    });
  } else if (result.status === "blocked" || result.status === "not_found") {
    phLogger.event("referral_reward_withheld", {
      userId,
      referrer_user_id: result.referrerUserId,
      referrer_subscription_tier: referrerSubscriptionTier,
      referral_code: referralCode,
      reason: result.reason,
      reward_type: "referred_signup",
    });
  }
  after(() => phLogger.flush());

  const response = NextResponse.json({
    attributed:
      result.status === "attributed" || result.status === "already_attributed",
    status: result.status,
    reason: result.reason,
    starterBonusAwarded: starterBonusMarkedAwarded,
    starterBonusUnitsAwarded,
    starterBonusUnits,
  });
  const shouldRetryStarterBonus =
    result.starterBonusEligible && !starterBonusMarkedAwarded;
  if (!shouldRetryStarterBonus) {
    clearReferralCookies(response);
  }
  return response;
}
