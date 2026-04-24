import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/app/api/stripe";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

/**
 * GET /api/extra-usage/confirm?session_id=cs_xxx
 *
 * Landing endpoint after Stripe Checkout completes. Verifies the session
 * directly with Stripe and credits the user's balance synchronously so they
 * see the new balance immediately on return. The async webhook at
 * /api/extra-usage/webhook remains the safety net for cases where the user
 * closes the tab before this route runs — both paths share a session-scoped
 * idempotency key (`cs_<session_id>`), so whichever commits first wins.
 */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("session_id");
  const origin = req.nextUrl.origin;

  if (!sessionId || !sessionId.startsWith("cs_")) {
    return NextResponse.redirect(origin, { status: 303 });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.type !== "extra_usage_purchase") {
      return NextResponse.redirect(origin, { status: 303 });
    }

    const userId = session.metadata.userId;
    const amountDollars = session.metadata.amountDollars
      ? parseFloat(session.metadata.amountDollars)
      : parseInt(session.metadata.amountCents ?? "0", 10) / 100;

    if (!userId || isNaN(amountDollars) || amountDollars <= 0) {
      console.error(
        "[Extra Usage Confirm] Invalid metadata on session:",
        session.id,
      );
      return NextResponse.redirect(origin, { status: 303 });
    }

    const redirectUrl = new URL(origin);
    redirectUrl.searchParams.set("extra-usage-purchased", "true");
    redirectUrl.searchParams.set("amount", String(amountDollars));

    // Async payment methods (e.g. bank debits) finalize later — webhook will
    // credit when Stripe sends `checkout.session.async_payment_succeeded` or
    // an eventual `checkout.session.completed` with `payment_status: paid`.
    if (session.payment_status !== "paid") {
      redirectUrl.searchParams.set("extra-usage-pending", "true");
      return NextResponse.redirect(redirectUrl, { status: 303 });
    }

    await convex.mutation(api.extraUsage.addCredits, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      userId,
      amountDollars,
      idempotencyKey: `cs_${session.id}`,
    });

    return NextResponse.redirect(redirectUrl, { status: 303 });
  } catch (err) {
    console.error("[Extra Usage Confirm] Failed to confirm session:", err);
    // Webhook is the safety net — don't block the user on confirm failures.
    const fallback = new URL(origin);
    fallback.searchParams.set("extra-usage-purchased", "true");
    return NextResponse.redirect(fallback, { status: 303 });
  }
}
