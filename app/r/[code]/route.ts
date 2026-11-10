import { randomUUID } from "node:crypto";
import {
  INFLUENCER_VISIT_COOKIE,
  VISIT_HANDOFF_SECONDS,
} from "@/lib/influencers/visit-handoff";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import {
  ATTRIBUTION_DAYS,
  INFLUENCER_COOKIE,
  validPartnerCode,
} from "@/lib/influencers/policy";
import {
  INFLUENCER_VISITOR_COOKIE,
  partnerCookie,
  readPartnerCookie,
} from "@/lib/influencers/cookie";
import { partnerTrackingAllowed } from "@/lib/influencers/attribution";
import {
  ANALYTICS_CONSENT_COOKIE_NAME,
  parseAnalyticsConsent,
} from "@/lib/privacy/analytics-consent";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const code = (await params).code.toLowerCase();
  if (!validPartnerCode(code))
    return new NextResponse("Referral link not found", { status: 404 });
  const partner = await getConvexClient().query(api.influencers.getPartner, {
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    code,
  });
  if (!partner?.active)
    return new NextResponse("Referral link not found", { status: 404 });
  const isBot = /bot|crawler|spider|preview/i.test(
    req.headers.get("user-agent") ?? "",
  );
  const allowed = partnerTrackingAllowed(req) && !isBot;
  const destination = new URL("/", req.url);
  if (
    !allowed &&
    !isBot &&
    parseAnalyticsConsent(
      req.cookies.get(ANALYTICS_CONSENT_COOKIE_NAME)?.value,
    ) === null
  ) {
    // Keep the code in the URL, without storage or analytics, until consent.
    destination.searchParams.set("ref", code);
  }
  const response = NextResponse.redirect(destination, 302);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-Robots-Tag", "noindex");
  if (allowed) {
    const firstClick = readPartnerCookie(
      req.cookies.get(INFLUENCER_COOKIE)?.value,
    );
    const visitor = readPartnerCookie(
      req.cookies.get(INFLUENCER_VISITOR_COOKIE)?.value,
    );
    const visitorId =
      firstClick?.visitorId ?? visitor?.visitorId ?? randomUUID();
    const options = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      path: "/",
      maxAge: ATTRIBUTION_DAYS * 86400,
    };
    if (!visitor?.visitorId)
      response.cookies.set(
        INFLUENCER_VISITOR_COOKIE,
        partnerCookie("visitor", Date.now(), visitorId),
        options,
      );
    if (!firstClick)
      response.cookies.set(
        INFLUENCER_COOKIE,
        partnerCookie(code, Date.now(), visitorId),
        options,
      );
    if (process.env.INFLUENCER_ANALYTICS_DISABLED !== "true") {
      response.cookies.set(
        INFLUENCER_VISIT_COOKIE,
        JSON.stringify({
          code,
          visitorId,
          visitId: randomUUID(),
          timestamp: Date.now(),
          environment:
            process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
        }),
        { ...options, httpOnly: false, maxAge: VISIT_HANDOFF_SECONDS },
      );
    }
  }
  return response;
}
