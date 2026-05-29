import { after, NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
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

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

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

  const { userId, subscription } = await getUserIDAndPro(req);
  if (subscription !== "free") {
    const response = NextResponse.json({
      attributed: false,
      reason: "existing_paid_user",
    });
    clearReferralCookies(response);
    return response;
  }

  const user = await workos.userManagement.getUser(userId);
  const result = await convex.mutation(api.referrals.attributeReferredSignup, {
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    referredUserId: userId,
    referralCode,
    starterBonusUnits: config.referredSignupBonusUnits,
    userCreatedAtMs: parseCreatedAtMs(user.createdAt),
    maxUserAgeDays: config.attributionMaxUserAgeDays,
    source: "referral_cookie",
  });

  let starterBonusUnitsAwarded = false;
  let starterBonusUnits = 0;
  let starterBonusMarkedAwarded = result.starterBonusAwarded;

  if (
    (result.status === "attributed" ||
      result.status === "already_attributed") &&
    result.starterBonusEligible &&
    config.referredSignupBonusUnits > 0
  ) {
    try {
      const grant = await grantFreeReferralBonusUnits(
        userId,
        config.referredSignupBonusUnits,
        `referral_signup:${userId}`,
      );

      if (grant.granted || grant.alreadyGranted) {
        const marked = await convex.mutation(
          api.referrals.markReferredSignupBonusGranted,
          {
            serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
            referredUserId: userId,
            referralCode,
            amountUnits: config.referredSignupBonusUnits,
          },
        );

        starterBonusMarkedAwarded = marked.awarded;
        starterBonusUnitsAwarded = grant.granted && marked.awarded;
        starterBonusUnits = starterBonusUnitsAwarded
          ? config.referredSignupBonusUnits
          : 0;
      }

      if (!grant.granted && !grant.alreadyGranted) {
        phLogger.warn("referral_signup_bonus_grant_failed", {
          userId,
          referrer_user_id: result.referrerUserId,
          referral_code: referralCode,
          starter_bonus_units: config.referredSignupBonusUnits,
        });
      }
    } catch (error) {
      phLogger.warn("referral_signup_bonus_grant_failed", {
        userId,
        referrer_user_id: result.referrerUserId,
        referral_code: referralCode,
        starter_bonus_units: config.referredSignupBonusUnits,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (result.status === "attributed") {
    phLogger.event("referred_signup_attributed", {
      userId,
      referrer_user_id: result.referrerUserId,
      referral_code: referralCode,
      starter_bonus_awarded: starterBonusUnitsAwarded,
      starter_bonus_units: starterBonusUnits,
    });
  } else if (result.status === "blocked" || result.status === "not_found") {
    phLogger.event("referral_reward_withheld", {
      userId,
      referrer_user_id: result.referrerUserId,
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
