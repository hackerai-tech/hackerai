"use server";

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

  cookieStore.delete(FIRST_TOUCH_ATTRIBUTION_COOKIE_NAME);
  cookieStore.delete(REFERRAL_COOKIE_NAME);
  cookieStore.delete(REFERRAL_COOKIE_CREATED_AT_NAME);

  const postHogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  if (postHogKey) {
    cookieStore.delete(`ph_${postHogKey}_posthog`);
  }
}
