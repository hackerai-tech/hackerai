import type { NextRequest } from "next/server";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { readPartnerCookie } from "./cookie";
import { INFLUENCER_COOKIE } from "./policy";
import {
  ANALYTICS_CONSENT_COOKIE_NAME,
  countryCodeFromHeaders,
  getAnalyticsConsentDecision,
} from "@/lib/privacy/analytics-consent";

export function partnerTrackingAllowed(req: NextRequest) {
  return getAnalyticsConsentDecision({
    cookieValue: req.cookies.get(ANALYTICS_CONSENT_COOKIE_NAME)?.value,
    countryCode: countryCodeFromHeaders(req.headers),
    failClosed: process.env.NODE_ENV === "production",
  }).analyticsAllowed;
}

export async function attributeInfluencer(
  req: NextRequest,
  user: {
    userId: string;
    identity?: string;
    createdAt: string;
    subscription: string;
  },
) {
  if (
    !user.identity ||
    user.subscription !== "free" ||
    !partnerTrackingAllowed(req)
  )
    return false;
  const click = readPartnerCookie(req.cookies.get(INFLUENCER_COOKIE)?.value);
  if (!click) return false;
  return await getConvexClient().mutation(api.influencers.attribute, {
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    identity: user.identity,
    userId: user.userId,
    userCreatedAt: Date.parse(user.createdAt),
    code: click.code,
    clickedAt: click.clickedAt,
  });
}
