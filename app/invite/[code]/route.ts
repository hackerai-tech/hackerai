import { after, NextRequest, NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { phLogger } from "@/lib/posthog/server";
import {
  encodeReferralCookie,
  REFERRAL_COOKIE_MAX_AGE_SECONDS,
  REFERRAL_COOKIE_NAME,
} from "@/lib/referrals";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code: rawCode } = await params;
  const code = rawCode.toUpperCase();
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? req.nextUrl.origin;
  const landingPath = `/invite/${encodeURIComponent(code)}`;
  const redirectUrl = new URL("/signup", baseUrl);
  const existingCookie = req.cookies.get(REFERRAL_COOKIE_NAME)?.value;

  try {
    const convex = getConvexClient();
    const referralCode = await convex.query(api.referrals.getReferralCode, {
      code,
    });

    if (!referralCode) {
      return NextResponse.redirect(new URL("/signup", baseUrl), {
        status: 303,
      });
    }

    phLogger.event("referral_invite_viewed", {
      userId: referralCode.referrerUserId,
      referrer_user_id: referralCode.referrerUserId,
      referral_code: referralCode.code,
      referral_landing_path: landingPath,
    });
    after(() => phLogger.flush());

    const response = NextResponse.redirect(redirectUrl, { status: 303 });
    if (!existingCookie) {
      response.cookies.set(
        REFERRAL_COOKIE_NAME,
        encodeReferralCookie({
          code: referralCode.code,
          landingPath,
          viewedAt: Date.now(),
        }),
        {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          maxAge: REFERRAL_COOKIE_MAX_AGE_SECONDS,
          path: "/",
        },
      );
    }

    return response;
  } catch (error) {
    phLogger.warn("referral_invite_route_failed", { code, error });
    after(() => phLogger.flush());
    return NextResponse.redirect(redirectUrl, { status: 303 });
  }
}
