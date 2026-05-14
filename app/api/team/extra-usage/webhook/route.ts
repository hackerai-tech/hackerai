import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/app/api/stripe";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import Stripe from "stripe";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

/**
 * POST /api/team/extra-usage/webhook
 * Handles Stripe webhook events for team extra usage purchases.
 *
 * Configure this webhook in Stripe Dashboard:
 * - Endpoint URL: https://your-domain.com/api/team/extra-usage/webhook
 * - Events to listen: checkout.session.completed
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    console.error("[Team Extra Usage Webhook] Missing stripe-signature header");
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 },
    );
  }

  const webhookSecret =
    process.env.STRIPE_TEAM_EXTRA_USAGE_WEBHOOK_SECRET ??
    process.env.STRIPE_EXTRA_USAGE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error(
      "[Team Extra Usage Webhook] No webhook secret configured (STRIPE_TEAM_EXTRA_USAGE_WEBHOOK_SECRET or STRIPE_EXTRA_USAGE_WEBHOOK_SECRET)",
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
    console.error(
      "[Team Extra Usage Webhook] Signature verification failed:",
      err,
    );
    return NextResponse.json(
      { error: "Webhook signature verification failed" },
      { status: 400 },
    );
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.metadata?.type !== "team_extra_usage_purchase") {
        return NextResponse.json({ received: true });
      }

      const organizationId = session.metadata.organizationId;
      const amountDollars = session.metadata.amountDollars
        ? parseFloat(session.metadata.amountDollars)
        : NaN;

      if (!organizationId || isNaN(amountDollars)) {
        console.error(
          "[Team Extra Usage Webhook] Invalid metadata in checkout session:",
          session.id,
        );
        return NextResponse.json(
          { error: "Invalid session metadata" },
          { status: 400 },
        );
      }

      try {
        const result = await convex.mutation(
          api.teamExtraUsage.addTeamCredits,
          {
            serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
            organizationId,
            amountDollars,
            idempotencyKey: `cs_${session.id}`,
            legacyIdempotencyKey: event.id,
          },
        );

        if (result.alreadyProcessed) {
          console.log(
            `[Team Extra Usage Webhook] Checkout session ${session.id} already processed, skipping`,
          );
        }
      } catch (error) {
        console.error(
          "[Team Extra Usage Webhook] FAILED to add credits:",
          error,
        );
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
