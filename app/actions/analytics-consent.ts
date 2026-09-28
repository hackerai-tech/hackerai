"use server";

import { INFLUENCER_COOKIE } from "@/lib/influencers/policy";
import {
  INFLUENCER_VISITOR_COOKIE,
  readPartnerCookie,
} from "@/lib/influencers/cookie";
import { getConvexClient } from "@/lib/db/convex-client";
import { api } from "@/convex/_generated/api";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { cookies } from "next/headers";
import {
  ANALYTICS_CONSENT_COOKIE_NAME,
  ANALYTICS_CONSENT_MAX_AGE_SECONDS,
  type AnalyticsConsent,
  parseAnalyticsConsent,
} from "@/lib/privacy/analytics-consent";
import { FIRST_TOUCH_ATTRIBUTION_COOKIE_NAME } from "@/lib/analytics/acquisition";
import {
  REFERRAL_COOKIE_CREATED_AT_NAME,
  REFERRAL_COOKIE_NAME,
} from "@/lib/referrals/config";

export async function saveAnalyticsConsent(
  requestedConsent: AnalyticsConsent,
): Promise<void> {
  const consent = parseAnalyticsConsent(requestedConsent);
  if (!consent) {
    throw new Error("Invalid analytics consent choice");
  }

  const cookieStore = await cookies();
  cookieStore.set(ANALYTICS_CONSENT_COOKIE_NAME, consent, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: ANALYTICS_CONSENT_MAX_AGE_SECONDS,
    path: "/",
  });

  if (consent === "accepted") return;

  // Resolve persisted attribution even when the visitor cookie has expired.
  const { user } = await withAuth();
  if (user) {
    let cursor: string | null = null;
    do {
      cursor = await getConvexClient().mutation(
        api.influencerAnalytics.optOut,
        {
          serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
          userId: user.id,
          cursor,
        },
      );
    } while (cursor !== null);
  }

  // Only a signed browser cookie may opt out its visitor. Preserve it if persistence fails so retry remains possible.
  for (const name of [INFLUENCER_COOKIE, INFLUENCER_VISITOR_COOKIE]) {
    const click = readPartnerCookie(cookieStore.get(name)?.value);
    if (click?.visitorId)
      await getConvexClient().mutation(api.influencerAnalytics.optOut, {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        visitorId: click.visitorId,
      });
  }
  cookieStore.delete(INFLUENCER_COOKIE);
  cookieStore.delete(INFLUENCER_VISITOR_COOKIE);
  cookieStore.delete(FIRST_TOUCH_ATTRIBUTION_COOKIE_NAME);
  cookieStore.delete(REFERRAL_COOKIE_NAME);
  cookieStore.delete(REFERRAL_COOKIE_CREATED_AT_NAME);

  const postHogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  if (postHogKey) {
    cookieStore.delete(`ph_${postHogKey}_posthog`);
  }
}
