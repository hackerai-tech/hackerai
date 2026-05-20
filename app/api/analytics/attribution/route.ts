import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";

const ATTRIBUTION_COOKIE = "hai_attribution";
const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

const cleanString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0
    ? value.slice(0, 500)
    : undefined;

export async function POST(req: NextRequest) {
  const { userId, subscription, organizationId } = await getUserIDAndPro(req);
  const cookieStore = await cookies();
  const raw = cookieStore.get(ATTRIBUTION_COOKIE)?.value;
  let attribution: Record<string, unknown> = {};

  if (raw) {
    try {
      attribution = JSON.parse(decodeURIComponent(raw));
    } catch {
      attribution = {};
    }
  }

  await convex.mutation(api.economics.upsertUserAccount, {
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    user_id: userId,
    current_subscription_tier: subscription,
    workos_organization_id: organizationId,
    utm_source: cleanString(attribution.utm_source),
    utm_medium: cleanString(attribution.utm_medium),
    utm_campaign: cleanString(attribution.utm_campaign),
    utm_content: cleanString(attribution.utm_content),
    utm_term: cleanString(attribution.utm_term),
    gclid: cleanString(attribution.gclid),
    fbclid: cleanString(attribution.fbclid),
    landing_page: cleanString(attribution.landing_page),
    referrer: cleanString(attribution.referrer),
  });

  return NextResponse.json({ ok: true });
}
