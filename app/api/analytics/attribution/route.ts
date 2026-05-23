import { NextRequest, NextResponse, after } from "next/server";
import { getUserID } from "@/lib/auth/get-user-id";
import { phLogger } from "@/lib/posthog/server";
import {
  ATTRIBUTION_COOKIE_NAME,
  attributionProperties,
  decodeAttributionCookie,
  sanitizeAttribution,
} from "@/lib/analytics/attribution";

export async function POST(req: NextRequest) {
  const userId = await getUserID(req);
  const body = await req.json().catch(() => ({}));
  const attribution =
    sanitizeAttribution(body?.attribution) ??
    decodeAttributionCookie(req.cookies.get(ATTRIBUTION_COOKIE_NAME)?.value);

  if (!attribution) {
    return NextResponse.json({ ok: true, captured: false });
  }

  const props = attributionProperties(attribution);
  const capturedAt = new Date().toISOString();

  phLogger.event("user_attribution_captured", {
    userId,
    ...props,
    $set_once: {
      ...props,
      first_attribution_captured_at: capturedAt,
    },
    $set: {
      last_attribution_captured_at: capturedAt,
    },
  });
  after(() => phLogger.flush());

  return NextResponse.json({ ok: true, captured: true });
}
