import { after, NextRequest, NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { getUserID } from "@/lib/auth/get-user-id";
import { getConvexClient } from "@/lib/db/convex-client";
import { phLogger } from "@/lib/posthog/server";
import { decodeReferralCookie, REFERRAL_COOKIE_NAME } from "@/lib/referrals";

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await getUserID(req);
  } catch {
    return NextResponse.json({ claimed: false }, { status: 401 });
  }

  const cookie = decodeReferralCookie(
    req.cookies.get(REFERRAL_COOKIE_NAME)?.value,
  );

  if (!cookie) {
    return NextResponse.json({
      claimed: false,
      reason: "no_referral_cookie",
    });
  }

  try {
    const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
    if (!serviceKey) {
      phLogger.error("referral_claim_missing_service_key", {
        missing_env: "CONVEX_SERVICE_ROLE_KEY",
      });
      after(() => phLogger.flush());
      return NextResponse.json(
        {
          claimed: false,
          reason: "missing_server_configuration",
        },
        { status: 500 },
      );
    }

    const convex = getConvexClient();
    const result = await convex.mutation(api.referrals.claimReferralSignup, {
      serviceKey,
      referredUserId: userId,
      referralCode: cookie.code,
      referralLandingPath: cookie.landingPath,
    });

    phLogger.event("referral_signup_started", {
      userId,
      referral_code: cookie.code,
      referral_landing_path: cookie.landingPath,
    });

    if (result.claimed) {
      phLogger.event("referral_signup_completed", {
        userId,
        referrer_user_id: result.referrerUserId,
        referral_code: result.referralCode,
        referral_landing_path: cookie.landingPath,
        starter_credits_awarded: result.starterCreditsAwarded,
      });
      phLogger.event("referral_reward_credited", {
        userId,
        referrer_user_id: result.referrerUserId,
        referral_code: result.referralCode,
        credits_awarded: result.starterCreditsAwarded,
        reward_reason: "referred_signup_bonus",
      });
    }

    after(() => phLogger.flush());

    const response = NextResponse.json(result);
    response.cookies.delete(REFERRAL_COOKIE_NAME);
    return response;
  } catch (error) {
    phLogger.warn("referral_claim_failed", { userId, error });
    const response = NextResponse.json({
      claimed: false,
      reason: "claim_failed",
    });
    response.cookies.delete(REFERRAL_COOKIE_NAME);
    after(() => phLogger.flush());
    return response;
  }
}
