import type { NextRequest } from "next/server";
import {
  ANALYTICS_CONSENT_COOKIE_NAME,
  getAnalyticsConsentDecision,
} from "@/lib/privacy/analytics-consent";
import {
  isRegionalFreeCountry,
  type RegionalFreeCountry,
} from "./regional-free-limits";

/** Vercel overwrites this header at ingress. Never trust client country/body fields. */
export function regionalFreeCountryFromRequest(
  req: NextRequest,
): RegionalFreeCountry | undefined {
  if (process.env.VERCEL !== "1") return;
  const country = req.headers.get("x-vercel-ip-country")?.trim().toUpperCase();
  if (!isRegionalFreeCountry(country)) return;
  const { analyticsAllowed } = getAnalyticsConsentDecision({
    cookieValue: req.cookies.get(ANALYTICS_CONSENT_COOKIE_NAME)?.value,
    countryCode: country,
    failClosed: true,
  });
  return analyticsAllowed ? country : undefined;
}
