import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/app/api/stripe";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

/**
 * GET /api/team/extra-usage/confirm?session_id=cs_xxx
 *
 * Landing endpoint after Stripe Checkout completes for a team purchase.
 * Mirrors /api/extra-usage/confirm but credits the org's team_extra_usage
 * row instead of the user's personal balance. Idempotency key is shared
 * with the webhook so they can race without double-crediting.
 */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("session_id");
  const origin = req.nextUrl.origin;

  if (!sessionId || !sessionId.startsWith("cs_")) {
    return NextResponse.redirect(origin, { status: 303 });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.type !== "team_extra_usage_purchase") {
      return NextResponse.redirect(origin, { status: 303 });
    }

    const organizationId = session.metadata.organizationId;
    const amountDollars = session.metadata.amountDollars
      ? parseFloat(session.metadata.amountDollars)
      : NaN;

    if (!organizationId || isNaN(amountDollars) || amountDollars <= 0) {
      console.error(
        "[Team Extra Usage Confirm] Invalid metadata on session:",
        session.id,
      );
      return NextResponse.redirect(origin, { status: 303 });
    }

    const redirectUrl = new URL(origin);
    redirectUrl.searchParams.set("team-extra-usage-purchased", "true");
    redirectUrl.searchParams.set("amount", String(amountDollars));

    if (session.payment_status !== "paid") {
      redirectUrl.searchParams.set("team-extra-usage-pending", "true");
      return NextResponse.redirect(redirectUrl, { status: 303 });
    }

    await convex.mutation(api.teamExtraUsage.addTeamCredits, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      organizationId,
      amountDollars,
      idempotencyKey: `cs_${session.id}`,
    });

    return NextResponse.redirect(redirectUrl, { status: 303 });
  } catch (err) {
    console.error("[Team Extra Usage Confirm] Failed to confirm session:", err);
    const fallback = new URL(origin);
    fallback.searchParams.set("team-extra-usage-purchased", "true");
    return NextResponse.redirect(fallback, { status: 303 });
  }
}
