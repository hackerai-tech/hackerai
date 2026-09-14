import type { NextRequest } from "next/server";
import {
  ANALYTICS_CONSENT_COOKIE_NAME,
  getAnalyticsConsentDecision,
} from "@/lib/privacy/analytics-consent";
import { isMonthlyBudgetCountry } from "./free-monthly-budget";

export function monthlyBudgetCountryFromRequest(
  req: NextRequest,
): string | undefined {
  if (process.env.VERCEL !== "1") return;
  const country = req.headers.get("x-vercel-ip-country")?.trim().toUpperCase();
  if (!isMonthlyBudgetCountry(country)) return;
  const { analyticsAllowed } = getAnalyticsConsentDecision({
    cookieValue: req.cookies.get(ANALYTICS_CONSENT_COOKIE_NAME)?.value,
    countryCode: country,
    failClosed: true,
  });
  return analyticsAllowed ? country : undefined;
}
