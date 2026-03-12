import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/app/api/stripe";
import { workos } from "@/app/api/workos";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import Stripe from "stripe";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

// =============================================================================
// Helpers
// =============================================================================

/** Cancel all Stripe subscriptions for a customer and delete the customer. */
async function cancelAndDeleteCustomer(customerId: string): Promise<void> {
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

  try {
    await stripe.customers.del(customerId);
  } catch (err) {
    console.warn(
      `[Fraud Webhook] Failed to delete Stripe customer ${customerId}:`,
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
 * Block a fraudulent user: cancel Stripe subscription, delete Stripe customer,
 * delete WorkOS organization and user account.
 */
async function blockFraudulentUser(customerId: string): Promise<void> {
  // Get WorkOS org from Stripe customer metadata
  let orgId: string | null = null;
  try {
    const customerData = await stripe.customers.retrieve(customerId);
    if (!customerData.deleted) {
      orgId = (customerData as Stripe.Customer).metadata?.workOSOrganizationId;
    }
  } catch (err) {
    console.warn(
      `[Fraud Webhook] Failed to retrieve customer ${customerId}:`,
      err,
    );
  }

  // Cancel subscriptions and delete Stripe customer
  await cancelAndDeleteCustomer(customerId);

  if (!orgId) {
    console.warn(
      `[Fraud Webhook] No WorkOS org found for customer ${customerId}, skipping user block`,
    );
    return;
  }

  // Resolve all user IDs from the organization, then delete org and users
  try {
    const memberships = await workos.userManagement.listOrganizationMemberships(
      {
        organizationId: orgId,
        statuses: ["active"],
      },
    );

    const userIds = memberships.data?.map((m) => m.userId) ?? [];

    // Delete the organization (removes all memberships)
    try {
      await workos.organizations.deleteOrganization(orgId);
      console.log(`[Fraud Webhook] Deleted WorkOS organization ${orgId}`);
    } catch (orgErr) {
      console.warn(
        `[Fraud Webhook] Failed to delete org ${orgId}, removing memberships instead:`,
        orgErr,
      );
      for (const m of memberships.data ?? []) {
        try {
          await workos.userManagement.deleteOrganizationMembership(m.id);
        } catch (memErr) {
          console.warn(
            `[Fraud Webhook] Failed to delete membership ${m.id}:`,
            memErr,
          );
        }
      }
    }

    // Delete each user account to fully block them
    for (const userId of userIds) {
      try {
        await workos.userManagement.deleteUser(userId);
        console.log(`[Fraud Webhook] Deleted WorkOS user ${userId}`);
      } catch (userErr) {
        console.warn(
          `[Fraud Webhook] Failed to delete user ${userId}:`,
          userErr,
        );
      }
    }
  } catch (err) {
    console.error(
      `[Fraud Webhook] Failed to resolve/block users for org ${orgId}:`,
      err,
    );
  }
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
    await blockFraudulentUser(customerId);
    console.log(
      `[Fraud Webhook] Blocked user for customer ${customerId} (early fraud warning)`,
    );
  }
}

/**
 * Handle charge.dispute.created
 *
 * Cancel subscription, delete Stripe customer, and block the user.
 */
async function handleDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
  const chargeId =
    typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;

  console.log(
    `[Fraud Webhook] Dispute created: ${dispute.id}, reason: ${dispute.reason}, amount: $${(dispute.amount / 100).toFixed(2)}, charge: ${chargeId}`,
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

  // Block the user
  await blockFraudulentUser(customerId);
  console.log(
    `[Fraud Webhook] Blocked user for customer ${customerId} (dispute ${dispute.id})`,
  );
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
