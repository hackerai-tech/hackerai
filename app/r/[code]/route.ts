import { after, NextRequest, NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import {
  ATTRIBUTION_DAYS,
  INFLUENCER_COOKIE,
  validPartnerCode,
} from "@/lib/influencers/policy";
import { partnerCookie, readPartnerCookie } from "@/lib/influencers/cookie";
import { partnerTrackingAllowed } from "@/lib/influencers/attribution";

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
  const response = NextResponse.redirect(new URL("/", req.url), 302);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-Robots-Tag", "noindex");
  if (
    partnerTrackingAllowed(req) &&
    !/bot|crawler|spider|preview/i.test(req.headers.get("user-agent") ?? "")
  ) {
    after(async () => {
      try {
        await getConvexClient().mutation(api.influencers.recordLinkOpen, {
          serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
          code,
        });
      } catch {
        console.warn("Influencer link-open counter unavailable");
      }
    });
  }
  if (
    partnerTrackingAllowed(req) &&
    !readPartnerCookie(req.cookies.get(INFLUENCER_COOKIE)?.value)
  ) {
    response.cookies.set(INFLUENCER_COOKIE, partnerCookie(code), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: ATTRIBUTION_DAYS * 86400,
    });
  }
  return response;
}
