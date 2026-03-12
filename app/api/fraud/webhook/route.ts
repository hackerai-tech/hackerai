import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/app/api/stripe";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import Stripe from "stripe";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

// =============================================================================
// Helpers
// =============================================================================

/** Cancel all active Stripe subscriptions for a customer. */
async function cancelAllSubscriptions(customerId: string): Promise<void> {
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
  });

  for (const sub of subs.data) {
    try {
      await stripe.subscriptions.cancel(sub.id as string);
    } catch (err) {
      console.warn(
        `[Fraud Webhook] Failed to cancel subscription ${sub.id}:`,
        err,
      );
    }
  }
}

/** Detach all payment methods from a customer to prevent future charges. */
async function detachAllPaymentMethods(customerId: string): Promise<void> {
  const paymentMethods = await stripe.paymentMethods.list({
    customer: customerId,
    limit: 100,
  });

  for (const pm of paymentMethods.data) {
    try {
      await stripe.paymentMethods.detach(pm.id);
    } catch (err) {
      console.warn(
        `[Fraud Webhook] Failed to detach payment method ${pm.id}:`,
        err,
      );
    }
  }
}

/** Mark the Stripe customer as blocked via metadata. */
async function markCustomerBlocked(
  customerId: string,
  reason: string,
): Promise<void> {
  try {
    await stripe.customers.update(customerId, {
      metadata: {
        blocked: "true",
        blocked_at: new Date().toISOString(),
        blocked_reason: reason,
      },
    });
  } catch (err) {
    console.warn(
      `[Fraud Webhook] Failed to mark customer ${customerId} as blocked:`,
      err,
    );
  }
}

/** Report a charge as fraudulent — feeds Stripe Radar's ML models. */
async function reportChargeFraudulent(chargeId: string): Promise<void> {
  try {
    await stripe.charges.update(chargeId, {
      fraud_details: { user_report: "fraudulent" },
    });
  } catch (err) {
    console.warn(
      `[Fraud Webhook] Failed to report charge ${chargeId} as fraudulent:`,
      err,
    );
  }
}

/** Resolve Stripe customer ID from a charge. */
function getCustomerIdFromCharge(charge: Stripe.Charge): string | null {
  return typeof charge.customer === "string"
    ? charge.customer
    : (charge.customer?.id ?? null);
}

/**
 * Block a fraudulent user without deleting anything.
 *
 * - Cancel all subscriptions (stops billing)
 * - Detach all payment methods (prevents future charges)
 * - Mark customer as blocked (metadata flag for app-layer checks)
 * - Report charge as fraudulent (feeds Radar ML)
 *
 * The Stripe customer and WorkOS account are preserved for:
 * - Dispute evidence (up to 120 days later)
 * - Pattern analysis (identifying fraud rings)
 * - Radar block list data (card fingerprints, email)
 */
async function blockFraudulentUser(
  customerId: string,
  chargeId: string,
  reason: string,
): Promise<void> {
  await cancelAllSubscriptions(customerId);
  await detachAllPaymentMethods(customerId);
  await markCustomerBlocked(customerId, reason);
  await reportChargeFraudulent(chargeId);

  console.log(
    `[Fraud Webhook] Blocked customer ${customerId}: subscriptions cancelled, payment methods detached, marked as blocked (${reason})`,
  );
}

// =============================================================================
// Event Handlers
// =============================================================================

/**
 * Handle radar.early_fraud_warning.created
 *
 * Auto-refund the charge and block the user. ~80% of early fraud warnings
 * become full disputes if not acted on. A proactive refund avoids the $15
 * dispute fee and doesn't count against the dispute ratio.
 */
async function handleEarlyFraudWarning(
  warning: Stripe.Radar.EarlyFraudWarning,
): Promise<void> {
  const chargeId =
    typeof warning.charge === "string" ? warning.charge : warning.charge?.id;

  if (!chargeId) {
    console.error(
      "[Fraud Webhook] Early fraud warning missing charge ID:",
      warning.id,
    );
    return;
  }

  console.log(
    `[Fraud Webhook] Early fraud warning for charge ${chargeId}, reason: ${warning.fraud_type}`,
  );

  const charge = await stripe.charges.retrieve(chargeId);
  const customerId = getCustomerIdFromCharge(charge);

  // Refund the charge immediately
  try {
    await stripe.refunds.create({
      charge: chargeId,
      reason: "fraudulent",
    });
    console.log(
      `[Fraud Webhook] Refunded charge ${chargeId} (early fraud warning)`,
    );
  } catch (err) {
    console.warn(`[Fraud Webhook] Could not refund charge ${chargeId}:`, err);
  }

  // Block the user
  if (customerId) {
    await blockFraudulentUser(
      customerId,
      chargeId,
      `early_fraud_warning:${warning.fraud_type}`,
    );
  }
}

/**
 * Handle charge.dispute.created
 *
 * Fraudulent disputes: block the user (cancel subs, detach cards, flag).
 * Non-fraudulent disputes (unrecognized, duplicate, etc.): cancel subscription
 * only — the customer may be legitimate and confused.
 */
async function handleDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
  const chargeId =
    typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
  const isFraudulent = dispute.reason === "fraudulent";

  console.log(
    `[Fraud Webhook] Dispute created: ${dispute.id}, reason: ${dispute.reason}, fraudulent: ${isFraudulent}, amount: $${(dispute.amount / 100).toFixed(2)}, charge: ${chargeId}`,
  );

  if (!chargeId) return;

  const charge = await stripe.charges.retrieve(chargeId);
  const customerId = getCustomerIdFromCharge(charge);

  if (!customerId) {
    console.error(
      `[Fraud Webhook] Could not resolve customer for dispute ${dispute.id}`,
    );
    return;
  }

  if (isFraudulent) {
    // Stolen card — block fully but preserve everything for evidence
    await blockFraudulentUser(
      customerId,
      chargeId,
      `dispute_fraudulent:${dispute.id}`,
    );
  } else {
    // Legitimate customer confused about the charge — just stop billing
    await cancelAllSubscriptions(customerId);
    console.log(
      `[Fraud Webhook] Cancelled subscriptions for customer ${customerId} (non-fraudulent dispute ${dispute.id}, reason: ${dispute.reason})`,
    );
  }
}

// =============================================================================
// Webhook Endpoint
// =============================================================================

/**
 * POST /api/fraud/webhook
 * Handles Stripe fraud-related events: early fraud warnings and disputes.
 *
 * Configure in Stripe Dashboard:
 * - Endpoint URL: https://your-domain.com/api/fraud/webhook
 * - Events: radar.early_fraud_warning.created, charge.dispute.created
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    console.error("[Fraud Webhook] Missing stripe-signature header");
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 },
    );
  }

  const webhookSecret = process.env.STRIPE_FRAUD_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error(
      "[Fraud Webhook] STRIPE_FRAUD_WEBHOOK_SECRET is not configured",
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
    console.error("[Fraud Webhook] Signature verification failed:", err);
    return NextResponse.json(
      { error: "Webhook signature verification failed" },
      { status: 400 },
    );
  }

  // Idempotency check
  try {
    const result = await convex.mutation(api.extraUsage.checkAndMarkWebhook, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      eventId: event.id,
      checkOnly: true,
    });

    if (result.alreadyProcessed) {
      console.log(
        `[Fraud Webhook] Event ${event.id} already processed, skipping`,
      );
      return NextResponse.json({ received: true });
    }
  } catch (error) {
    console.error("[Fraud Webhook] Idempotency check failed:", error);
    return NextResponse.json(
      { error: "Failed to check idempotency" },
      { status: 500 },
    );
  }

  // Handle events
  switch (event.type) {
    case "radar.early_fraud_warning.created": {
      await handleEarlyFraudWarning(
        event.data.object as Stripe.Radar.EarlyFraudWarning,
      );
      break;
    }
    case "charge.dispute.created": {
      await handleDisputeCreated(event.data.object as Stripe.Dispute);
      break;
    }
  }

  // Mark as processed
  try {
    await convex.mutation(api.extraUsage.checkAndMarkWebhook, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      eventId: event.id,
    });
  } catch (error) {
    console.error(
      `[Fraud Webhook] Failed to mark event ${event.id} as processed:`,
      error,
    );
  }

  return NextResponse.json({ received: true });
}
