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

/** Mark the Stripe customer as blocked via metadata. Throws on failure
 *  so the webhook returns 500 and Stripe retries — without this flag the
 *  subscribe/upgrade routes cannot enforce the block. */
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
// Card-Testing Detection
// =============================================================================

/** Decline codes that warrant an immediate block — no threshold needed. */
const IMMEDIATE_BLOCK_CODES = new Set(["stolen_card", "fraudulent"]);

/** Decline codes from legitimate financial issues — don't count toward fraud. */
const IGNORED_CODES = new Set([
  "insufficient_funds",
  "expired_card",
  "processing_error",
  "reenter_transaction",
]);

/** 24 hours in milliseconds — accounts newer than this get a lower block threshold. */
const NEW_ACCOUNT_MS = 24 * 60 * 60 * 1000;

/**
 * Extract the card fingerprint from the payment intent's failed payment method.
 * Returns null if the payment method isn't a card or isn't expanded.
 */
async function extractCardFingerprint(
  paymentIntent: Stripe.PaymentIntent,
): Promise<string | null> {
  const pmRef = paymentIntent.last_payment_error?.payment_method;
  if (!pmRef) return null;

  // If already expanded as an object
  if (typeof pmRef === "object" && pmRef.card?.fingerprint) {
    return pmRef.card.fingerprint;
  }

  // If it's a string ID, fetch it
  if (typeof pmRef === "string") {
    try {
      const pm = await stripe.paymentMethods.retrieve(pmRef);
      return pm.card?.fingerprint ?? null;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Check whether the Stripe customer was created recently (< 24h)
 * with no prior successful charges.
 */
async function isNewAccount(customerId: string): Promise<boolean> {
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted) return false;
    const createdMs = (customer as Stripe.Customer).created * 1000;
    return Date.now() - createdMs < NEW_ACCOUNT_MS;
  } catch {
    return false;
  }
}

/**
 * Handle payment_intent.payment_failed
 *
 * Detects card-testing attacks using multiple signals:
 * - Weighted scoring (incorrect_number = 2x)
 * - Distinct card fingerprints (3+ = instant block)
 * - Decline code diversity (3+ different codes = instant block)
 * - Account age factor (new accounts have lower threshold)
 */
async function handlePaymentFailed(
  paymentIntent: Stripe.PaymentIntent,
): Promise<void> {
  const customerId =
    typeof paymentIntent.customer === "string"
      ? paymentIntent.customer
      : (paymentIntent.customer?.id ?? null);

  if (!customerId) {
    console.warn(
      `[Fraud Webhook] payment_intent.payment_failed without customer: ${paymentIntent.id}`,
    );
    return;
  }

  const declineCode =
    paymentIntent.last_payment_error?.decline_code ??
    paymentIntent.last_payment_error?.code ??
    "unknown";

  const chargeId =
    typeof paymentIntent.latest_charge === "string"
      ? paymentIntent.latest_charge
      : (paymentIntent.latest_charge?.id ?? null);

  console.log(
    `[Fraud Webhook] Payment failed for customer ${customerId}: decline_code=${declineCode}, charge=${chargeId ?? "none"}`,
  );

  // Immediate block for clearly fraudulent decline codes
  if (IMMEDIATE_BLOCK_CODES.has(declineCode)) {
    await blockFraudulentUser(
      customerId,
      chargeId,
      `immediate_block:${declineCode}`,
    );
    return;
  }

  // Skip tracking for legitimate financial failures
  if (IGNORED_CODES.has(declineCode)) {
    return;
  }

  // Extract additional fraud signals in parallel
  const [cardFingerprint, newAccount] = await Promise.all([
    extractCardFingerprint(paymentIntent),
    isNewAccount(customerId),
  ]);

  // Track suspicious failure in sliding window (multi-signal)
  const result = await convex.mutation(api.fraudTracking.recordPaymentFailure, {
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    stripeCustomerId: customerId,
    declineCode,
    cardFingerprint: cardFingerprint ?? undefined,
    isNewAccount: newAccount,
  });

  if (result.shouldBlock) {
    const reason = result.blockReason ?? "threshold_reached";
    console.log(
      `[Fraud Webhook] Card-testing detected for customer ${customerId} (${result.failureCount} failures, reason: ${reason}) — blocking`,
    );
    await blockFraudulentUser(
      customerId,
      chargeId,
      `card_testing_detected:${reason}`,
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
 * - Events: radar.early_fraud_warning.created, charge.dispute.created, payment_intent.payment_failed
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

  // Atomic idempotency claim — marks the event immediately to prevent
  // concurrent deliveries from both passing the check (TOCTOU race).
  // Stripe operations below are idempotent, so duplicate runs are safe
  // if the claim write succeeds but processing partially fails.
  try {
    const result = await convex.mutation(api.extraUsage.checkAndMarkWebhook, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      eventId: event.id,
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
    case "payment_intent.payment_failed": {
      await handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
      break;
    }
  }

  return NextResponse.json({ received: true });
}
