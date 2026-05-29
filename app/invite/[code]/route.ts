import { NextRequest, NextResponse } from "next/server";
import {
  REFERRAL_COOKIE_CREATED_AT_NAME,
  REFERRAL_COOKIE_NAME,
  getReferralRewardConfig,
  isValidReferralCode,
} from "@/lib/referrals/config";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ code: string }>;
};

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { code: rawCode } = await params;
  const referralCode = rawCode ?? "";
  const redirectUrl = new URL("/signup", request.url);
  if (referralCode) {
    redirectUrl.searchParams.set("referral_code", referralCode);
  }
  const response = NextResponse.redirect(redirectUrl);

  const config = getReferralRewardConfig();
  if (!config.enabled || !isValidReferralCode(referralCode)) {
    return response;
  }

  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: config.cookieMaxAgeSeconds,
    path: "/",
  };

  response.cookies.set(REFERRAL_COOKIE_NAME, referralCode, cookieOptions);
  response.cookies.set(
    REFERRAL_COOKIE_CREATED_AT_NAME,
    String(Date.now()),
    cookieOptions,
  );

  return response;
}
