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
  await stripe.customers.update(customerId, {
    metadata: {
      blocked: "true",
      blocked_at: new Date().toISOString(),
      blocked_reason: reason,
    },
  });
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

/**
 * Refund a charge for an early fraud warning.
 *
 * Uses an idempotency key derived from the EFW ID so that webhook retries
 * (or TOCTOU duplicate deliveries) collapse onto a single refund instead
 * of erroring with `charge_already_refunded`.
 *
 * Terminal failures (`charge_already_refunded`, `charge_disputed`,
 * `charge_pending`) are logged and treated as success: there is nothing
 * to retry. All other errors bubble so the webhook returns 500 and Stripe
 * retries the delivery — silently swallowing transient errors here would
 * defeat the entire point of the EFW path (refund proactively to avoid
 * the dispute fee + ratio impact).
 */
async function refundChargeForEFW(
  chargeId: string,
  efwId: string,
): Promise<void> {
  try {
    await stripe.refunds.create(
      { charge: chargeId, reason: "fraudulent" },
      { idempotencyKey: `efw-refund:${efwId}` },
    );
    console.log(
      `[Fraud Webhook] Refunded charge ${chargeId} (early fraud warning ${efwId})`,
    );
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      const code = err.code;
      if (
        code === "charge_already_refunded" ||
        code === "charge_disputed" ||
        code === "charge_pending"
      ) {
        console.log(
          `[Fraud Webhook] Refund skipped for ${chargeId} (EFW ${efwId}): ${code}`,
        );
        return;
      }
    }
    // Transient or unexpected — bubble so Stripe retries the webhook.
    console.error(
      `[Fraud Webhook] Refund failed for ${chargeId} (EFW ${efwId}):`,
      err,
    );
    throw err;
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
 * - Mark customer as blocked (metadata flag)
 * - Report charge as fraudulent (feeds Radar ML) — skipped when no charge
 *
 * The Stripe customer and WorkOS account are preserved for:
 * - Dispute evidence (up to 120 days later)
 * - Pattern analysis (identifying fraud rings)
 * - Radar block list data (card fingerprints, email)
 */
async function blockFraudulentUser(
  customerId: string,
  chargeId: string | null,
  reason: string,
): Promise<void> {
  await cancelAllSubscriptions(customerId);
  await detachAllPaymentMethods(customerId);
  await markCustomerBlocked(customerId, reason);
  if (chargeId) {
    await reportChargeFraudulent(chargeId);
  }

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

  // Refund first. Throws on transient errors so Stripe retries the webhook.
  await refundChargeForEFW(chargeId, warning.id);

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
 *
 * No refund call: when a dispute is created, Stripe automatically debits the
 * disputed amount (plus a non-refundable dispute fee) from the merchant
 * balance. Calling stripe.refunds.create here would error with
 * "charge_disputed" / double-refund. The disputed funds are returned to the
 * cardholder by their issuer, not by us.
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
    // Non-fraudulent dispute (unrecognized, duplicate, product issue, etc.).
    // The customer may be legitimate but a chargeback still costs us the
    // dispute fee + ratio impact, and the disputed card is likely to file
    // again. Stop all future charges on this card: cancel subscriptions
    // AND detach payment methods. Don't mark blocked — the customer can
    // still re-subscribe with a different card if they want to continue.
    await cancelAllSubscriptions(customerId);
    await detachAllPaymentMethods(customerId);
    console.log(
      `[Fraud Webhook] Cancelled subscriptions and detached payment methods for customer ${customerId} (non-fraudulent dispute ${dispute.id}, reason: ${dispute.reason})`,
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

  // Atomic claim — eliminates the TOCTOU window where two concurrent
  // deliveries of the same event.id could both pass a read-then-write
  // pre-check and both run side effects. claimWebhookProcessing inserts
  // a `pending` row in a single transaction; only one caller wins.
  // Stale `pending` claims (>10 min) are reclaimable so a crashed first
  // attempt doesn't permanently block Stripe's retries.
  let claimState: "acquired" | "already_processed" | "claim_held";
  try {
    const result = await convex.mutation(
      api.extraUsage.claimWebhookProcessing,
      {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        eventId: event.id,
      },
    );
    claimState = result.state;
  } catch (error) {
    console.error("[Fraud Webhook] Claim failed:", error);
    return NextResponse.json(
      { error: "Failed to claim webhook" },
      { status: 500 },
    );
  }

  if (claimState !== "acquired") {
    console.log(`[Fraud Webhook] Event ${event.id} ${claimState}, skipping`);
    return NextResponse.json({ received: true });
  }

  // Handle events. If the handler throws, return 500 WITHOUT finalizing —
  // the `pending` claim will become reclaimable after STALE_CLAIM_MS so a
  // future Stripe retry can drive completion.
  try {
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
  } catch (error) {
    console.error(
      `[Fraud Webhook] Handler failed for event ${event.id} (${event.type}):`,
      error,
    );
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }

  // Finalize the claim. If this write itself fails, log and continue:
  // a duplicate Stripe retry would re-run the (now individually idempotent)
  // handler operations, so the missed finalize is recoverable.
  try {
    await convex.mutation(api.extraUsage.finalizeWebhookProcessing, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      eventId: event.id,
    });
  } catch (error) {
    console.error(
      `[Fraud Webhook] Failed to finalize event ${event.id}:`,
      error,
    );
  }

  return NextResponse.json({ received: true });
}
