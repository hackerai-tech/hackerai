import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/app/api/stripe";
import { workos } from "@/app/api/workos";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import Stripe from "stripe";
import {
  resetRateLimitBuckets,
  stashOldBucketRemaining,
  popOldBucketRemaining,
  initProratedBucket,
  clearOrgRemovedUsage,
} from "@/lib/rate-limit";
import type { SubscriptionTier } from "@/types";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

// =============================================================================
// Tier Resolution
// =============================================================================

/** Map Stripe price lookup key to subscription tier. */
function planLookupKeyToTier(lookupKey: string): SubscriptionTier | null {
  if (lookupKey.startsWith("ultra")) return "ultra";
  if (lookupKey.startsWith("pro-plus")) return "pro-plus";
  if (lookupKey.startsWith("team")) return "team";
  if (lookupKey.startsWith("pro")) return "pro";
  return null;
}

// =============================================================================
// Helpers
// =============================================================================

/** Resolve all active WorkOS user IDs and org ID from a Stripe customer ID. */
async function resolveUserIdsFromCustomer(
  customerId: string,
): Promise<{ userIds: string[]; orgId: string | null }> {
  try {
    const customerData = await stripe.customers.retrieve(customerId);
    if (customerData.deleted) return { userIds: [], orgId: null };

    const customer = customerData as Stripe.Customer;
    const orgId = customer.metadata?.workOSOrganizationId ?? null;
    if (!orgId) {
      console.error(
        `[Subscription Webhook] Customer ${customerId} missing workOSOrganizationId metadata`,
      );
      return { userIds: [], orgId: null };
    }

    const memberships = await workos.userManagement.listOrganizationMemberships(
      {
        organizationId: orgId,
        statuses: ["active"],
      },
    );

    if (!memberships.data || memberships.data.length === 0) {
      console.error(
        `[Subscription Webhook] No active memberships for org ${orgId}`,
      );
      return { userIds: [], orgId };
    }

    return { userIds: memberships.data.map((m) => m.userId), orgId };
  } catch (error) {
    console.error(
      `[Subscription Webhook] Failed to resolve users for customer ${customerId}:`,
      error,
    );
    return { userIds: [], orgId: null };
  }
}

/** Infer subscription tier from a Stripe product name (fallback when lookup_key is missing). */
function tierFromProductName(name: string): SubscriptionTier | null {
  const lower = name.toLowerCase();
  if (lower.includes("ultra")) return "ultra";
  if (lower.includes("pro-plus") || lower.includes("pro plus"))
    return "pro-plus";
  if (lower.includes("team")) return "team";
  if (lower.includes("pro")) return "pro";
  return null;
}

/** Resolve subscription tier and object from a Stripe subscription ID. */
async function resolveSubscription(subscriptionId: string): Promise<{
  tier: SubscriptionTier;
  subscription: Stripe.Subscription;
} | null> {
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["items.data.price", "items.data.price.product"],
    });

    const price = subscription.items?.data[0]?.price;
    const lookupKey = price?.lookup_key ?? null;

    if (lookupKey) {
      const tier = planLookupKeyToTier(lookupKey);
      return tier ? { tier, subscription } : null;
    }

    // Fallback: infer tier from product name or metadata when lookup_key is missing
    const product = price?.product;
    const productObj =
      product && typeof product === "object" && !("deleted" in product)
        ? (product as Stripe.Product)
        : null;

    const tier =
      (productObj?.metadata?.tier as SubscriptionTier | undefined) ??
      (productObj?.name ? tierFromProductName(productObj.name) : null);

    if (tier) {
      console.warn(
        `[Subscription Webhook] Subscription ${subscriptionId} missing price lookup_key, resolved tier "${tier}" from product fallback`,
      );
      return { tier, subscription };
    }

    console.error(
      `[Subscription Webhook] Subscription ${subscriptionId} has no price lookup_key and could not infer tier from product`,
    );
    return null;
  } catch (error) {
    console.error(
      `[Subscription Webhook] Failed to retrieve subscription ${subscriptionId}:`,
      error,
    );
    return null;
  }
}

// =============================================================================
// Event Handlers
// =============================================================================

/** Handle invoice.paid — reset rate limit buckets on subscription payment. */
async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  // In Stripe API 2026-03-25, subscription lives under invoice.parent.subscription_details
  const subDetails = invoice.parent?.subscription_details;
  const subscriptionId = subDetails
    ? typeof subDetails.subscription === "string"
      ? subDetails.subscription
      : subDetails.subscription?.id
    : null;

  // Only process subscription invoices (not one-time payments)
  if (!subscriptionId) return;

  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer?.id;

  if (!customerId) {
    console.error(
      "[Subscription Webhook] invoice.paid missing customer ID:",
      invoice.id,
    );
    return;
  }

  const [customerResult, resolved] = await Promise.all([
    resolveUserIdsFromCustomer(customerId),
    resolveSubscription(subscriptionId),
  ]);

  const { userIds, orgId } = customerResult;

  if (userIds.length === 0 || !resolved) {
    console.error(
      `[Subscription Webhook] Could not resolve users (${userIds.length}) or subscription for invoice ${invoice.id}`,
    );
    return;
  }

  const { tier, subscription } = resolved;
  const billingReason = (invoice as any).billing_reason as string | undefined;

  // Mid-cycle tier change: prorate credits based on remaining time in the cycle.
  // Only prorate if handleSubscriptionUpdated stashed old-tier data (confirms
  // a real tier change). Other subscription_update reasons (quantity changes,
  // billing anchor changes) fall through to the full reset path.
  if (billingReason === "subscription_update") {
    // Check each user for a tier-change stash; collect those that have one
    const stashResults = await Promise.all(
      userIds.map(async (uid) => ({
        uid,
        stash: await popOldBucketRemaining(uid),
      })),
    );

    const tierChangeUsers = stashResults.filter((r) => r.stash !== null);

    if (tierChangeUsers.length > 0) {
      console.log(
        `[Subscription Webhook] invoice.paid (upgrade): prorating ${tier} buckets for ${tierChangeUsers.length} user(s)`,
      );

      const periodStart = (subscription as any).current_period_start as number;
      const periodEnd = (subscription as any).current_period_end as number;
      const now = Math.floor(Date.now() / 1000);
      const totalDuration = periodEnd - periodStart;
      const remaining = periodEnd - now;

      const proratedRatio = Math.max(
        0,
        Math.min(1, totalDuration > 0 ? remaining / totalDuration : 1),
      );

      await Promise.all(
        tierChangeUsers.map(({ uid, stash }) =>
          initProratedBucket(uid, tier, proratedRatio, stash!.consumed),
        ),
      );

      // Any users without a stash (shouldn't happen, but safe fallback)
      const nonTierChangeUsers = stashResults.filter((r) => r.stash === null);
      if (nonTierChangeUsers.length > 0) {
        await Promise.all(
          nonTierChangeUsers.map(({ uid }) => resetRateLimitBuckets(uid, tier)),
        );
      }

      return;
    }
    // No stash found for any user — not a tier change, fall through to full reset
  }

  // Regular renewal or new subscription: full credits
  console.log(
    `[Subscription Webhook] invoice.paid (${billingReason ?? "unknown"}): resetting ${tier} buckets for ${userIds.length} user(s)`,
  );
  await Promise.all(userIds.map((uid) => resetRateLimitBuckets(uid, tier)));

  // Clear team seat rotation debt on renewal (fresh cycle)
  if (tier === "team" && orgId) {
    await clearOrgRemovedUsage(orgId);
  }
}

/** Handle customer.subscription.updated — reset old tier's buckets on plan change. */
async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription,
  previousAttributes: Partial<Stripe.Subscription> | undefined,
): Promise<void> {
  // Only act if the subscription items actually changed (plan change)
  const previousItems = (previousAttributes as any)?.items;
  if (!previousItems) return;

  const currentPrice = subscription.items?.data[0]?.price;
  const currentLookupKey = currentPrice?.lookup_key ?? null;
  let currentTier = currentLookupKey
    ? planLookupKeyToTier(currentLookupKey)
    : null;

  // Fallback: infer current tier from product when lookup_key is missing
  if (!currentTier && currentPrice?.product) {
    const product = currentPrice.product;
    const productObj =
      product && typeof product === "object" && !("deleted" in product)
        ? (product as Stripe.Product)
        : null;
    currentTier =
      (productObj?.metadata?.tier as SubscriptionTier | undefined) ??
      (productObj?.name ? tierFromProductName(productObj.name) : null) ??
      null;
  }

  const prevLookupKey = previousItems?.data?.[0]?.price?.lookup_key ?? null;
  const previousTier = prevLookupKey
    ? planLookupKeyToTier(prevLookupKey)
    : null;

  // If tiers are the same, invoice.paid will handle the reset
  if (currentTier === previousTier) return;

  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id;

  if (!customerId) return;

  const { userIds } = await resolveUserIdsFromCustomer(customerId);
  if (userIds.length === 0) {
    console.error(
      `[Subscription Webhook] subscription.updated: could not resolve users for customer ${customerId}`,
    );
    return;
  }

  console.log(
    `[Subscription Webhook] subscription.updated: tier change ${previousTier} → ${currentTier} for ${userIds.length} user(s)`,
  );

  // Stash remaining credits from old tier before deleting, then reset old buckets
  if (previousTier) {
    await Promise.all(
      userIds.map((uid) => stashOldBucketRemaining(uid, previousTier)),
    );
    await Promise.all(
      userIds.map((uid) => resetRateLimitBuckets(uid, previousTier)),
    );
  }
}

// =============================================================================
// Webhook Endpoint
// =============================================================================

/**
 * POST /api/subscription/webhook
 * Handles Stripe subscription lifecycle events to reset rate limit buckets.
 *
 * Configure in Stripe Dashboard:
 * - Endpoint URL: https://your-domain.com/api/subscription/webhook
 * - Events: invoice.paid, customer.subscription.updated
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    console.error("[Subscription Webhook] Missing stripe-signature header");
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 },
    );
  }

  const webhookSecret = process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error(
      "[Subscription Webhook] STRIPE_SUBSCRIPTION_WEBHOOK_SECRET is not configured",
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
    console.error("[Subscription Webhook] Signature verification failed:", err);
    return NextResponse.json(
      { error: "Webhook signature verification failed" },
      { status: 400 },
    );
  }

  // Idempotency check (check only — mark after successful processing)
  try {
    const result = await convex.mutation(api.extraUsage.checkAndMarkWebhook, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      eventId: event.id,
      checkOnly: true,
    });

    if (result.alreadyProcessed) {
      console.log(
        `[Subscription Webhook] Event ${event.id} already processed, skipping`,
      );
      return NextResponse.json({ received: true });
    }
  } catch (error) {
    console.error("[Subscription Webhook] Idempotency check failed:", error);
    // Return 500 so Stripe retries
    return NextResponse.json(
      { error: "Failed to check idempotency" },
      { status: 500 },
    );
  }

  // Handle events
  switch (event.type) {
    case "invoice.paid": {
      await handleInvoicePaid(event.data.object as Stripe.Invoice);
      break;
    }
    case "customer.subscription.updated": {
      await handleSubscriptionUpdated(
        event.data.object as Stripe.Subscription,
        event.data.previous_attributes as
          | Partial<Stripe.Subscription>
          | undefined,
      );
      break;
    }
  }

  // Mark as processed after successful handling
  try {
    await convex.mutation(api.extraUsage.checkAndMarkWebhook, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      eventId: event.id,
    });
  } catch (error) {
    // Log but don't fail — the event was already handled successfully
    console.error(
      `[Subscription Webhook] Failed to mark event ${event.id} as processed:`,
      error,
    );
  }

  return NextResponse.json({ received: true });
}
