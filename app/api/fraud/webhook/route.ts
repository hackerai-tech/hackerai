import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/app/api/stripe";
import { getConvexClient } from "@/lib/db/convex-client";
import { api } from "@/convex/_generated/api";
import Stripe from "stripe";
import { resolveUserIdsFromCustomer as resolveStripeCustomerUsers } from "@/lib/billing/resolve-customer-users";
import {
  logStripeWebhookMissingSignature,
  logStripeWebhookSignatureVerificationFailed,
} from "@/lib/billing/stripe-webhook-logging";
import { refundChargeForEFW } from "@/lib/billing/fraud-refund";
import {
  isTerminalPaymentMethodDetachError,
  isTerminalStripeResourceError,
} from "@/lib/billing/stripe-terminal-errors";

const WEBHOOK_LOG_PREFIX = "[Fraud Webhook]";
const WEBHOOK_LOG_CONTEXT = {
  webhook: "fraud",
  route: "/api/fraud/webhook",
};

type SuspensionCategory =
  "early_fraud_warning" | "dispute_fraudulent" | "dispute_billing_hold";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Cancel every Stripe subscription while the account hold is active. A replay
 * intentionally cleans up post-event drift too: suspended accounts may not
 * re-subscribe until support resolves the hold.
 */
async function cancelAllSubscriptions(customerId: string): Promise<void> {
  let startingAfter: string | undefined;
  const subscriptions: Stripe.Subscription[] = [];

  do {
    let page: Stripe.ApiList<Stripe.Subscription>;
    try {
      page = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 100,
        ...(startingAfter && { starting_after: startingAfter }),
      });
    } catch (err) {
      if (isTerminalStripeResourceError(err)) {
        console.log(
          `[Fraud Webhook] Subscription cleanup skipped for customer ${customerId}: resource_missing`,
        );
        return;
      }
      throw err;
    }

    subscriptions.push(...page.data);
    startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
  } while (startingAfter);

  for (const sub of subscriptions) {
    try {
      await stripe.subscriptions.cancel(sub.id as string);
    } catch (err) {
      if (isTerminalStripeResourceError(err)) {
        console.log(
          `[Fraud Webhook] Cancel skipped for subscription ${sub.id}: resource_missing`,
        );
        continue;
      }
      console.error(
        `[Fraud Webhook] Failed to cancel subscription ${sub.id}:`,
        err,
      );
      throw err;
    }
  }
}

/**
 * Detach every payment method while the account hold is active. This prevents
 * a replacement card from becoming a path around the dispute suspension.
 */
async function detachAllPaymentMethods(customerId: string): Promise<void> {
  let startingAfter: string | undefined;
  const paymentMethods: Stripe.PaymentMethod[] = [];

  do {
    let page: Stripe.ApiList<Stripe.PaymentMethod>;
    try {
      page = await stripe.paymentMethods.list({
        customer: customerId,
        limit: 100,
        ...(startingAfter && { starting_after: startingAfter }),
      });
    } catch (err) {
      if (isTerminalStripeResourceError(err)) {
        console.log(
          `[Fraud Webhook] Payment method cleanup skipped for customer ${customerId}: resource_missing`,
        );
        return;
      }
      throw err;
    }

    paymentMethods.push(...page.data);
    startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
  } while (startingAfter);

  for (const pm of paymentMethods) {
    try {
      await stripe.paymentMethods.detach(pm.id);
    } catch (err) {
      if (isTerminalPaymentMethodDetachError(err)) {
        console.log(
          `[Fraud Webhook] Detach skipped for payment method ${pm.id}: already detached or missing`,
        );
        continue;
      }
      console.error(
        `[Fraud Webhook] Failed to detach payment method ${pm.id}:`,
        err,
      );
      throw err;
    }
  }
}

/** Expire every open Checkout session while the account hold is active. */
async function expireOpenCheckoutSessions(customerId: string): Promise<void> {
  let startingAfter: string | undefined;
  const openSessions: Stripe.Checkout.Session[] = [];

  do {
    let sessions: Stripe.ApiList<Stripe.Checkout.Session>;
    try {
      sessions = await stripe.checkout.sessions.list({
        customer: customerId,
        status: "open",
        limit: 100,
        ...(startingAfter && { starting_after: startingAfter }),
      });
    } catch (err) {
      if (isTerminalStripeResourceError(err)) {
        console.log(
          `[Fraud Webhook] Checkout cleanup skipped for customer ${customerId}: resource_missing`,
        );
        return;
      }
      throw err;
    }

    openSessions.push(...sessions.data);
    startingAfter = sessions.has_more ? sessions.data.at(-1)?.id : undefined;
  } while (startingAfter);

  // Fetch every page before mutating the result set. Expiring sessions while
  // cursoring through only open sessions can otherwise skip later pages.
  for (const session of openSessions) {
    try {
      await stripe.checkout.sessions.expire(session.id);
    } catch (err) {
      if (isTerminalStripeResourceError(err)) {
        console.log(
          `[Fraud Webhook] Checkout expiration skipped for session ${session.id}: resource_missing`,
        );
        continue;
      }
      throw err;
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
    if (isTerminalStripeResourceError(err)) {
      console.log(
        `[Fraud Webhook] Block metadata skipped for customer ${customerId}: resource_missing`,
      );
      return;
    }
    throw err;
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

const resolveUserIdsFromCustomer = (customerId: string) =>
  resolveStripeCustomerUsers(customerId, "Fraud Webhook");

async function suspendCustomerUsers({
  customerId,
  category,
  sourceId,
  sourceReason,
  chargeId,
  sourceCreatedUnix,
}: {
  customerId: string;
  category: SuspensionCategory;
  sourceId: string;
  sourceReason?: string;
  chargeId?: string | null;
  sourceCreatedUnix: number;
}): Promise<void> {
  const { userIds, orgId } = await resolveUserIdsFromCustomer(customerId);

  for (const userId of userIds) {
    await getConvexClient().mutation(api.userSuspensions.upsertActive, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      userId,
      category,
      sourceId,
      sourceReason,
      stripeCustomerId: customerId,
      stripeChargeId: chargeId ?? undefined,
      workosOrganizationId: orgId ?? undefined,
      sourceCreatedAt: sourceCreatedUnix * 1000,
    });
  }
}

/**
 * Block a fraudulent user without deleting anything.
 *
 * - Suspend cost-incurring app usage
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
  metadataReason: string,
  suspension: {
    category: SuspensionCategory;
    sourceId: string;
    sourceReason?: string;
  },
  sourceCreatedUnix: number,
): Promise<void> {
  // Suspend first so a customer deleted during Stripe cleanup cannot prevent
  // the local safety control from being applied. The upsert is replay-safe.
  await suspendCustomerUsers({
    customerId,
    category: suspension.category,
    sourceId: suspension.sourceId,
    sourceReason: suspension.sourceReason,
    chargeId,
    sourceCreatedUnix,
  });
  await expireOpenCheckoutSessions(customerId);
  await cancelAllSubscriptions(customerId);
  await detachAllPaymentMethods(customerId);
  await markCustomerBlocked(customerId, metadataReason);
  if (chargeId) {
    await reportChargeFraudulent(chargeId);
  }

  console.log(
    `[Fraud Webhook] Processed fraud block for customer ${customerId} (${metadataReason})`,
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
  await refundChargeForEFW(stripe, charge, warning.id);

  // Block the user
  if (customerId) {
    await blockFraudulentUser(
      customerId,
      chargeId,
      `early_fraud_warning:${warning.fraud_type}`,
      {
        category: "early_fraud_warning",
        sourceId: warning.id,
        sourceReason: warning.fraud_type,
      },
      warning.created,
    );
  }
}

/**
 * Handle charge.dispute.created
 *
 * Fraudulent disputes: block the user (cancel subs, detach cards, flag).
 * Non-fraudulent disputes (unrecognized, duplicate, etc.): cancel subscription,
 * detach payment methods, and pause cost-incurring usage. The customer may be
 * legitimate and confused, so we don't mark the Stripe customer as blocked.
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
      {
        category: "dispute_fraudulent",
        sourceId: dispute.id,
        sourceReason: dispute.reason,
      },
      dispute.created,
    );
  } else {
    // Non-fraudulent dispute (unrecognized, duplicate, product issue, etc.).
    // The customer may be legitimate but a chargeback still costs us the
    // dispute fee + ratio impact, and the disputed card is likely to file
    // again. Stop all future charges on this card: cancel subscriptions
    // AND detach payment methods. Don't mark the Stripe customer as a fraud
    // actor, but keep the Convex billing hold authoritative: every app billing
    // path rejects new transactions until support resolves the suspension.
    await suspendCustomerUsers({
      customerId,
      category: "dispute_billing_hold",
      sourceId: dispute.id,
      sourceReason: dispute.reason,
      chargeId,
      sourceCreatedUnix: dispute.created,
    });
    await expireOpenCheckoutSessions(customerId);
    await cancelAllSubscriptions(customerId);
    await detachAllPaymentMethods(customerId);
    console.log(
      `[Fraud Webhook] Processed billing hold for customer ${customerId} (non-fraudulent dispute ${dispute.id}, reason: ${dispute.reason})`,
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
    logStripeWebhookMissingSignature({
      logPrefix: WEBHOOK_LOG_PREFIX,
      ...WEBHOOK_LOG_CONTEXT,
      requestHeaders: req.headers,
      body,
      signature,
    });
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
    logStripeWebhookSignatureVerificationFailed({
      logPrefix: WEBHOOK_LOG_PREFIX,
      ...WEBHOOK_LOG_CONTEXT,
      requestHeaders: req.headers,
      body,
      signature,
      error: err,
    });
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
    const result = await getConvexClient().mutation(
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
  // a duplicate Stripe retry would re-run the handler operations, but the
  // cleanup operations are idempotent and re-read current Stripe state. A
  // replay therefore removes any subscription, card, or open Checkout session
  // that drifted in after the original dispute event while the hold remained
  // active.
  try {
    await getConvexClient().mutation(api.extraUsage.finalizeWebhookProcessing, {
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
