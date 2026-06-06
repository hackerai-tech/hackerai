import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import {
  getReferralRewardConfig,
  isValidReferralCode,
} from "@/lib/referrals/config";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export const runtime = "nodejs";

const REFERRAL_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REFERRAL_CODE_LENGTH = 7;

const generateReferralCode = () =>
  Array.from(randomBytes(REFERRAL_CODE_LENGTH), (byte) =>
    REFERRAL_CODE_ALPHABET.charAt(byte % REFERRAL_CODE_ALPHABET.length),
  ).join("");

export async function GET(req: NextRequest) {
  const config = getReferralRewardConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { error: "Referral program is paused" },
      { status: 403 },
    );
  }

  const { userId, subscription, organizationId } = await getUserIDAndPro(req);

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  if (!baseUrl) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_BASE_URL is not configured" },
      { status: 500 },
    );
  }

  let result: {
    code: string;
    active: boolean;
    referrerSubscriptionTier: string;
    attributedSignups: number;
    paidConversions: number;
    awardedDollars: number;
  } | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const codeCandidate = generateReferralCode();
    if (!isValidReferralCode(codeCandidate)) continue;

    try {
      result = await convex.mutation(api.referrals.getOrCreateReferralCode, {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        userId,
        subscriptionTier: subscription,
        organizationId,
        codeCandidate,
      });
      break;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Referral code collision")
      ) {
        continue;
      }
      throw error;
    }
  }

  if (!result) {
    return NextResponse.json(
      { error: "Failed to create referral code" },
      { status: 500 },
    );
  }

  const referralUrl = new URL(
    `/invite/${encodeURIComponent(result.code)}`,
    baseUrl,
  );

  return NextResponse.json({
    code: result.code,
    active: result.active,
    referralUrl: referralUrl.toString(),
    referrerSubscriptionTier: result.referrerSubscriptionTier,
    referrerRewardDollars: config.referrerRewardDollars,
    referredSignupBonusUnits: config.referredSignupBonusUnits,
    stats: {
      attributedSignups: result.attributedSignups,
      paidConversions: result.paidConversions,
      awardedDollars: result.awardedDollars,
    },
  });
}
