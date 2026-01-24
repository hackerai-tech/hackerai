import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/app/api/stripe";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import Stripe from "stripe";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

/**
 * POST /api/extra-usage/webhook
 * Handles Stripe webhook events for extra usage purchases.
 *
 * Configure this webhook in Stripe Dashboard:
 * - Endpoint URL: https://your-domain.com/api/extra-usage/webhook
 * - Events to listen: checkout.session.completed
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    console.error("[Extra Usage Webhook] Missing stripe-signature header");
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 },
    );
  }

  const webhookSecret = process.env.STRIPE_EXTRA_USAGE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error(
      "[Extra Usage Webhook] STRIPE_EXTRA_USAGE_WEBHOOK_SECRET is not configured",
    );
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 },
    );
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    console.error("[Extra Usage Webhook] Signature verification failed:", err);
    return NextResponse.json(
      { error: "Webhook signature verification failed" },
      { status: 400 },
    );
  }

  // Handle the event
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      // Only process extra usage purchases
      if (session.metadata?.type !== "extra_usage_purchase") {
        return NextResponse.json({ received: true });
      }

      const userId = session.metadata.userId;
      // Support both new (amountDollars) and old (amountCents) metadata formats
      const amountDollars = session.metadata.amountDollars
        ? parseFloat(session.metadata.amountDollars)
        : parseInt(session.metadata.amountCents, 10) / 100;

      if (!userId || isNaN(amountDollars)) {
        console.error(
          "[Extra Usage Webhook] Invalid metadata in checkout session:",
          session.id,
        );
        return NextResponse.json(
          { error: "Invalid session metadata" },
          { status: 400 },
        );
      }

      // Add credits to user's balance (idempotent - uses Stripe event ID for deduplication)
      try {
        const result = await convex.mutation(api.extraUsage.addCredits, {
          serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
          userId,
          amountDollars,
          idempotencyKey: event.id, // Stripe event ID is stable across retries
        });

        if (result.alreadyProcessed) {
          console.log(
            `[Extra Usage Webhook] Checkout session ${session.id} already processed, skipping`,
          );
        }
      } catch (error) {
        console.error("[Extra Usage Webhook] FAILED to add credits:", error);
        // Return 500 so Stripe retries
        return NextResponse.json(
          { error: "Failed to add credits" },
          { status: 500 },
        );
      }

      break;
    }
  }

  return NextResponse.json({ received: true });
}
