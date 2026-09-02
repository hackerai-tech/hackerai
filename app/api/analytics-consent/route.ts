import { NextResponse, type NextRequest } from "next/server";
import {
  ANALYTICS_CONSENT_COOKIE_NAME,
  countryCodeFromHeaders,
  getAnalyticsConsentDecision,
} from "@/lib/privacy/analytics-consent";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const decision = getAnalyticsConsentDecision({
    cookieValue: request.cookies.get(ANALYTICS_CONSENT_COOKIE_NAME)?.value,
    countryCode: countryCodeFromHeaders(request.headers),
    failClosed: process.env.NODE_ENV === "production",
  });

  return NextResponse.json(
    {
      consent: decision.consent,
      consentRequired: decision.consentRequired,
    },
    {
      headers: {
        "Cache-Control": "private, no-store",
      },
    },
  );
}
