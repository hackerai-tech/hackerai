import { flushInfluencerAnalytics } from "@/lib/influencers/analytics";
import { after, NextRequest, NextResponse } from "next/server";
import { stripe } from "@/app/api/stripe";
import { getConvexClient } from "@/lib/db/convex-client";
import { handleInfluencerEvent } from "@/lib/influencers/stripe";
import { influencerErrorSummary } from "@/lib/influencers/errors";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_INFLUENCER_WEBHOOK_SECRET;
  if (!secret)
    return NextResponse.json({ error: "Webhook unavailable" }, { status: 503 });
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      await req.text(),
      req.headers.get("stripe-signature") ?? "",
      secret,
    );
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }
  try {
    // Invoice IDs deduplicate writes. Keep this endpoint independent of the
    // subscription fulfillment webhook's shared event-id ledger.
    await handleInfluencerEvent(stripe, getConvexClient(), event);
    after(() => flushInfluencerAnalytics().then(() => {}));
    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Influencer reconciliation failed", {
      eventId: event.id,
      eventType: event.type,
      error: influencerErrorSummary(error),
    });
    return NextResponse.json(
      { error: "Reconciliation failed" },
      { status: 500 },
    );
  }
}
