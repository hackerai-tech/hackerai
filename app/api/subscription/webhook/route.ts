import { NextRequest, NextResponse, after } from "next/server";
import { stripe } from "@/app/api/stripe";
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
import { phLogger } from "@/lib/posthog/server";
import { resolveUserIdsFromCustomer as resolveStripeCustomerUsers } from "@/lib/billing/resolve-customer-users";
import { getInvoicePaidBucketResetMode } from "@/lib/billing/subscription-invoice-reset";
import {
  priceBillingInterval,
  subscriptionMrrDollars,
} from "@/lib/billing/subscription-mrr";
import type { SubscriptionTier } from "@/types";
import { getReferralRewardConfig } from "@/lib/referrals/config";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";

// Linear ranking used to label tier transitions as upgrade/downgrade. Team is
// pinned at the top because moves between team and individual plans are rare
// and analysts can re-bucket from `from_tier`/`to_tier` if needed.
const TIER_ORDER: readonly SubscriptionTier[] = [
  "free",
  "pro",
  "pro-plus",
  "ultra",
  "team",
];

function tierDirection(
  from: SubscriptionTier | null,
  to: SubscriptionTier | null,
): "upgrade" | "downgrade" | "lateral" {
  const fi = from ? TIER_ORDER.indexOf(from) : -1;
  const ti = to ? TIER_ORDER.indexOf(to) : -1;
  if (ti > fi) return "upgrade";
  if (ti < fi) return "downgrade";
  return "lateral";
}

type PaidStartTier = Exclude<SubscriptionTier, "free">;

const centsToDollars = (amount: number | null | undefined): number =>
  (amount ?? 0) / 100;

function invoicePaidAtMs(invoice: Stripe.Invoice): number {
  const paidAt = invoice.status_transitions?.paid_at;
  if (paidAt) return paidAt * 1000;
  return (
    ((invoice as { created?: number }).created ?? Date.now() / 1000) * 1000
  );
}

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

function toPaidStartTier(tier: SubscriptionTier): PaidStartTier | null {
  return tier === "free" ? null : tier;
}

// =============================================================================
// Helpers
// =============================================================================

const resolveUserIdsFromCustomer = (customerId: string) =>
  resolveStripeCustomerUsers(customerId, "Subscription Webhook");

const metadataString = (
  metadata: Stripe.Metadata | null | undefined,
  key: string,
): string | undefined => {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

function subscriptionCurrentPeriodEndSeconds(
  subscription: Stripe.Subscription,
): number | undefined {
  const periodEnd = (subscription as { current_period_end?: unknown })
    .current_period_end;
  return typeof periodEnd === "number" &&
    Number.isFinite(periodEnd) &&
    periodEnd > 0
    ? periodEnd
    : undefined;
}

function monthlyUsagePeriodEndSeconds(
  subscription: Stripe.Subscription,
): number | undefined {
  const price = subscription.items?.data[0]?.price;
  if (priceBillingInterval(price) !== "month") return undefined;
  if ((price?.recurring?.interval_count ?? 1) !== 1) return undefined;
  return subscriptionCurrentPeriodEndSeconds(subscription);
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

async function awardReferralConversion(args: {
  tier: SubscriptionTier;
  subscription: Stripe.Subscription;
  customerId: string;
  plan?: string;
  invoiceId?: string;
  checkoutSessionId?: string;
  checkoutAttemptId?: string;
}) {
  const config = getReferralRewardConfig();
  if (!config.enabled || config.referrerRewardDollars <= 0) {
    return;
  }
  if (args.tier === "free") {
    return;
  }

  const metadata = args.subscription.metadata;
  const referredUserId =
    metadataString(metadata, "userId") ??
    metadataString(metadata, "referral_referred_user_id");

  try {
    const result = await convex.mutation(api.referrals.awardConversionReward, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      referrerRewardDollars: config.referrerRewardDollars,
      referredUserId,
      stripeCheckoutSessionId: args.checkoutSessionId,
      stripeCustomerId: args.customerId,
      stripeSubscriptionId: args.subscription.id,
      stripeInvoiceId: args.invoiceId,
      plan: args.plan,
      tier: args.tier,
    });

    if (result.status === "awarded" || result.status === "already_awarded") {
      if (result.referredUserId ?? referredUserId) {
        phLogger.event("referred_user_paid_conversion", {
          userId: result.referredUserId ?? referredUserId,
          referrer_user_id: result.referrerUserId,
          referral_code: result.referralCode,
          reward_status: result.status,
          plan: args.plan,
          tier: args.tier,
          stripe_customer_id: args.customerId,
          stripe_subscription_id: args.subscription.id,
          stripe_invoice_id: args.invoiceId,
          stripe_checkout_session_id: args.checkoutSessionId,
          checkout_attempt_id: args.checkoutAttemptId,
        });
      }

      if (result.status === "awarded" && result.referrerUserId) {
        phLogger.event("referrer_credits_awarded", {
          userId: result.referrerUserId,
          referred_user_id: result.referredUserId ?? referredUserId,
          referral_code: result.referralCode,
          reward_dollars: config.referrerRewardDollars,
          plan: args.plan,
          tier: args.tier,
          stripe_customer_id: args.customerId,
          stripe_subscription_id: args.subscription.id,
          stripe_invoice_id: args.invoiceId,
          stripe_checkout_session_id: args.checkoutSessionId,
          checkout_attempt_id: args.checkoutAttemptId,
        });
      }
    } else if (result.status === "withheld") {
      phLogger.event("referral_reward_withheld", {
        userId: result.referredUserId ?? referredUserId,
        referrer_user_id: result.referrerUserId,
        referral_code: result.referralCode,
        reward_type: "referrer_conversion",
        reason: result.reason,
        plan: args.plan,
        tier: args.tier,
        stripe_customer_id: args.customerId,
        stripe_subscription_id: args.subscription.id,
        stripe_invoice_id: args.invoiceId,
        stripe_checkout_session_id: args.checkoutSessionId,
        checkout_attempt_id: args.checkoutAttemptId,
      });
    }
  } catch (error) {
    phLogger.error("referral_conversion_reward_failed", {
      userId: referredUserId,
      stripe_customer_id: args.customerId,
      stripe_subscription_id: args.subscription.id,
      stripe_invoice_id: args.invoiceId,
      stripe_checkout_session_id: args.checkoutSessionId,
      checkout_attempt_id: args.checkoutAttemptId,
      error,
    });
  }
}

async function setReferralCodesPaidEligibility(args: {
  userIds: string[];
  active: boolean;
  tier?: SubscriptionTier | null;
  organizationId?: string;
}) {
  const config = getReferralRewardConfig();
  if (!config.enabled || args.userIds.length === 0) {
    return;
  }

  const subscriptionTier =
    args.active && args.tier && args.tier !== "free" ? args.tier : undefined;

  try {
    await convex.mutation(api.referrals.setReferralCodesPaidEligibility, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      userIds: args.userIds,
      active: args.active,
      ...(subscriptionTier && { subscriptionTier }),
      ...(args.organizationId && { organizationId: args.organizationId }),
    });
  } catch (error) {
    phLogger.warn("referral_paid_eligibility_update_failed", {
      userId: args.userIds[0],
      user_ids: args.userIds,
      active: args.active,
      tier: args.tier,
      organization_id: args.organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function recordSubscriptionRevenue({
  invoice,
  customerId,
  userIds,
  orgId,
  tier,
  subscription,
  reason,
}: {
  invoice: Stripe.Invoice;
  customerId: string;
  userIds: string[];
  orgId?: string;
  tier: SubscriptionTier;
  subscription: Stripe.Subscription;
  reason: string;
}) {
  const grossRevenueDollars = centsToDollars(
    (invoice as { amount_paid?: number }).amount_paid,
  );

  if (grossRevenueDollars <= 0 || userIds.length === 0) return;

  const item = subscription.items?.data[0];
  const price = item?.price;
  const occurredAt = invoicePaidAtMs(invoice);
  const attributedRevenueDollars = grossRevenueDollars / userIds.length;
  const attributionStrategy = userIds.length > 1 ? "split_evenly" : "direct";
  const mrrDollars =
    reason === "subscription_create" || reason === "subscription_cycle"
      ? subscriptionMrrDollars({
          price,
          quantity: item?.quantity ?? 1,
          fallbackTotalIntervalAmountDollars: grossRevenueDollars,
        })
      : undefined;
  const attributedMrrDollars =
    mrrDollars === undefined ? undefined : mrrDollars / userIds.length;

  await Promise.all([
    ...userIds.map((uid) =>
      convex.mutation(api.unitEconomics.recordRevenueEvent, {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        entityType: "user",
        entityId: uid,
        userId: uid,
        organizationId: orgId,
        source: "subscription",
        sourceEventId: invoice.id,
        idempotencyKey: `subscription:${invoice.id}:user:${uid}`,
        grossRevenueDollars: attributedRevenueDollars,
        mrrDollars: attributedMrrDollars,
        currency: invoice.currency ?? "usd",
        occurredAt,
        attributionStrategy,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id,
        stripeInvoiceId: invoice.id,
        stripePriceId: price?.id,
        plan: price?.lookup_key ?? tier,
        quantity: item?.quantity,
        userCount: userIds.length,
        description: reason,
      }),
    ),
    ...(orgId
      ? [
          convex.mutation(api.unitEconomics.recordRevenueEvent, {
            serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
            entityType: "organization",
            entityId: orgId,
            organizationId: orgId,
            source: "subscription",
            sourceEventId: invoice.id,
            idempotencyKey: `subscription:${invoice.id}:organization:${orgId}`,
            grossRevenueDollars,
            mrrDollars,
            currency: invoice.currency ?? "usd",
            occurredAt,
            attributionStrategy: "organization_pool",
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscription.id,
            stripeInvoiceId: invoice.id,
            stripePriceId: price?.id,
            plan: price?.lookup_key ?? tier,
            quantity: item?.quantity,
            userCount: userIds.length,
            description: reason,
          }),
        ]
      : []),
  ]);
}

async function recordPaidStartMix({
  invoice,
  customerId,
  userIds,
  orgId,
  tier,
  subscription,
}: {
  invoice: Stripe.Invoice;
  customerId: string;
  userIds: string[];
  orgId?: string;
  tier: SubscriptionTier;
  subscription: Stripe.Subscription;
}) {
  const paidStartTier = toPaidStartTier(tier);
  if (!paidStartTier || userIds.length === 0) return;

  const item = subscription.items?.data[0];
  const price = item?.price;
  const occurredAt = invoicePaidAtMs(invoice);
  const entityType = orgId ? "organization" : "user";
  const entityId = orgId ?? userIds[0];
  const paidSeatCount = item?.quantity ?? userIds.length;

  await convex.mutation(api.unitEconomics.recordPaidStartEvent, {
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    entityType,
    entityId,
    userId: userIds[0],
    organizationId: orgId,
    sourceEventId: invoice.id,
    idempotencyKey: `paid_start:${invoice.id}:${entityType}:${entityId}`,
    occurredAt,
    conversionType: "free_to_paid",
    tier: paidStartTier,
    plan: price?.lookup_key ?? paidStartTier,
    paidAccountStartCount: 1,
    paidUserStartCount: userIds.length,
    paidSeatCount,
    billingInterval: priceBillingInterval(price),
    billingIntervalCount: price?.recurring?.interval_count,
    quantity: item?.quantity,
    userCount: userIds.length,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    stripeInvoiceId: invoice.id,
    stripePriceId: price?.id,
  });
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

  const resetMode = getInvoicePaidBucketResetMode(invoice);
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

  await setReferralCodesPaidEligibility({
    userIds,
    active: true,
    tier,
    organizationId: orgId ?? undefined,
  });

  try {
    await recordSubscriptionRevenue({
      invoice,
      customerId,
      userIds,
      orgId: orgId ?? undefined,
      tier,
      subscription,
      reason: resetMode.reason,
    });
  } catch (error) {
    console.error("[Subscription Webhook] Failed to record revenue:", {
      error,
      invoiceId: invoice.id,
      customerId,
      userCount: userIds.length,
      orgId,
      tier,
      resetReason: resetMode.reason,
    });
  }

  if (resetMode.mode === "skip") {
    console.log(
      `[Subscription Webhook] invoice.paid (${resetMode.reason}): skipping bucket reset for invoice ${invoice.id}`,
    );
    return;
  }

  // Mid-cycle tier change: prorate credits based on remaining time in the cycle.
  // Only prorate if handleSubscriptionUpdated stashed old-tier data (confirms
  // a real tier change). Other subscription_update reasons (quantity changes,
  // billing anchor changes) are ignored so they cannot mint fresh credits.
  if (resetMode.mode === "subscription_update_proration") {
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
          initProratedBucket(
            uid,
            tier,
            proratedRatio,
            stash!.consumed,
            periodEnd,
          ),
        ),
      );

      // Any users without a stash (shouldn't happen, but safe fallback)
      const nonTierChangeUsers = stashResults.filter((r) => r.stash === null);
      if (nonTierChangeUsers.length > 0) {
        const fallbackUsagePeriodEnd =
          monthlyUsagePeriodEndSeconds(subscription);
        await Promise.all(
          nonTierChangeUsers.map(({ uid }) =>
            resetRateLimitBuckets(uid, tier, fallbackUsagePeriodEnd),
          ),
        );
      }

      return;
    }

    console.log(
      `[Subscription Webhook] invoice.paid (subscription_update): no tier-change stash for invoice ${invoice.id}; skipping bucket reset`,
    );
    return;
  }

  // Regular renewal or new subscription: full credits
  console.log(
    `[Subscription Webhook] invoice.paid (${resetMode.reason}): resetting ${tier} buckets for ${userIds.length} user(s)`,
  );
  const usagePeriodEnd = monthlyUsagePeriodEndSeconds(subscription);
  await Promise.all(
    userIds.map((uid) => resetRateLimitBuckets(uid, tier, usagePeriodEnd)),
  );

  if (resetMode.reason === "subscription_create") {
    const item = subscription.items?.data[0];
    const price = item?.price;
    const checkoutAttemptId = metadataString(
      subscription.metadata,
      "checkoutAttemptId",
    );
    const checkoutSource = metadataString(
      subscription.metadata,
      "checkoutSource",
    );
    const checkoutSurface = metadataString(
      subscription.metadata,
      "checkoutSurface",
    );
    const checkoutSessionId = metadataString(
      subscription.metadata,
      "stripeCheckoutSessionId",
    );
    const invoiceAmountPaidDollars = centsToDollars(
      (invoice as { amount_paid?: number }).amount_paid,
    );
    const attributedRevenueDollars =
      userIds.length > 0 ? invoiceAmountPaidDollars / userIds.length : 0;
    const billingInterval = priceBillingInterval(price);
    const subscriptionMrr = subscriptionMrrDollars({
      price,
      quantity: item?.quantity ?? 1,
      fallbackTotalIntervalAmountDollars: invoiceAmountPaidDollars,
    });
    const attributedMrrDollars =
      subscriptionMrr === undefined
        ? undefined
        : subscriptionMrr / userIds.length;
    const paidSeatCount = item?.quantity ?? userIds.length;

    try {
      await recordPaidStartMix({
        invoice,
        customerId,
        userIds,
        orgId: orgId ?? undefined,
        tier,
        subscription,
      });
    } catch (error) {
      console.error("[Subscription Webhook] Failed to record paid start mix:", {
        error,
        invoiceId: invoice.id,
        customerId,
        userCount: userIds.length,
        orgId,
        tier,
      });
    }

    for (const [index, uid] of userIds.entries()) {
      phLogger.event("subscription_started", {
        userId: uid,
        from_tier: "free",
        to_tier: tier,
        conversion_type: "free_to_paid",
        org_id: orgId,
        user_count: userIds.length,
        plan: price?.lookup_key,
        paid_account_start_count: index === 0 ? 1 : 0,
        paid_user_start_count: 1,
        paid_account_user_count: userIds.length,
        paid_seat_count: paidSeatCount,
        paid_start_plan: price?.lookup_key ?? tier,
        paid_start_tier: tier,
        billing_interval: billingInterval,
        paid_start_billing_interval: billingInterval ?? "unknown",
        billing_interval_count: price?.recurring?.interval_count,
        quantity: item?.quantity,
        checkout_attempt_id: checkoutAttemptId,
        checkout_type:
          metadataString(subscription.metadata, "checkoutType") ??
          "new_subscription",
        surface: checkoutSurface,
        source: checkoutSource,
        invoice_amount_paid_dollars: invoiceAmountPaidDollars,
        attributed_revenue_dollars: attributedRevenueDollars,
        revenue_dollars: attributedRevenueDollars,
        subscription_mrr_dollars: subscriptionMrr,
        attributed_mrr_dollars: attributedMrrDollars,
        mrr_dollars: attributedMrrDollars,
        currency: invoice.currency,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscription.id,
        stripe_invoice_id: invoice.id,
        stripe_checkout_session_id: checkoutSessionId,
        stripe_price_id: price?.id,
        $set: {
          subscription_tier: tier,
          last_subscription_started_at: new Date().toISOString(),
        },
        $set_once: {
          first_subscription_started_at: new Date().toISOString(),
          first_paid_tier: tier,
        },
      });
    }

    await awardReferralConversion({
      tier,
      subscription,
      customerId,
      plan: price?.lookup_key ?? undefined,
      invoiceId: invoice.id,
      checkoutSessionId,
      checkoutAttemptId,
    });
  }

  // Clear team seat rotation debt on renewal (fresh cycle)
  if (tier === "team" && orgId) {
    await clearOrgRemovedUsage(orgId);
  }
}

/** Handle checkout.session.completed — attach Checkout Session IDs to saved referral attribution. */
async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  if (session.mode !== "subscription") return;

  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id;
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;

  if (!customerId) return;

  const referredUserId =
    metadataString(session.metadata, "userId") ??
    metadataString(session.metadata, "referral_referred_user_id");
  const checkoutAttemptId = metadataString(
    session.metadata,
    "checkoutAttemptId",
  );
  const checkoutSource = metadataString(session.metadata, "checkoutSource");
  const checkoutSurface = metadataString(session.metadata, "checkoutSurface");
  const checkoutType =
    metadataString(session.metadata, "checkoutType") ?? "new_subscription";
  const organizationId = metadataString(
    session.metadata,
    "workOSOrganizationId",
  );

  if (referredUserId) {
    try {
      await convex.mutation(api.referrals.recordReferralCheckoutSession, {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        referredUserId,
        stripeCustomerId: customerId,
        stripeCheckoutSessionId: session.id,
        stripeSubscriptionId: subscriptionId,
        requestedPlan:
          metadataString(session.metadata, "requestedPlan") ?? "unknown",
      });
    } catch (error) {
      phLogger.warn("referral_checkout_session_record_failed", {
        userId: referredUserId,
        stripe_customer_id: customerId,
        stripe_checkout_session_id: session.id,
        stripe_subscription_id: subscriptionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!subscriptionId || session.payment_status !== "paid") return;

  const resolved = await resolveSubscription(subscriptionId);
  if (!resolved) return;

  const price = resolved.subscription.items?.data[0]?.price;
  const existingMetadata = resolved.subscription.metadata ?? {};
  if (checkoutAttemptId || checkoutSource || checkoutSurface) {
    try {
      await stripe.subscriptions.update(subscriptionId, {
        metadata: {
          ...existingMetadata,
          ...(checkoutAttemptId && { checkoutAttemptId }),
          ...(checkoutSource && { checkoutSource }),
          ...(checkoutSurface && { checkoutSurface }),
          checkoutType,
          stripeCheckoutSessionId: session.id,
        },
      });
    } catch (error) {
      phLogger.warn("subscription_checkout_metadata_update_failed", {
        userId: referredUserId,
        stripe_subscription_id: subscriptionId,
        stripe_checkout_session_id: session.id,
        checkout_attempt_id: checkoutAttemptId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (referredUserId) {
    phLogger.event(
      PAID_FUNNEL_EVENTS.checkoutSucceeded,
      paidFunnelProperties({
        userId: referredUserId,
        org_id: organizationId,
        checkout_attempt_id: checkoutAttemptId,
        checkout_type: checkoutType,
        from_tier: "free",
        to_tier: resolved.tier,
        plan:
          metadataString(session.metadata, "requestedPlan") ??
          price?.lookup_key,
        billing_interval: priceBillingInterval(price),
        billing_interval_count: price?.recurring?.interval_count,
        quantity: resolved.subscription.items?.data[0]?.quantity,
        surface: checkoutSurface,
        source: checkoutSource,
        checkout_amount_dollars: centsToDollars(session.amount_total),
        currency: session.currency,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        stripe_checkout_session_id: session.id,
        stripe_price_id: price?.id,
        payment_status: session.payment_status,
        $insert_id: `${PAID_FUNNEL_EVENTS.checkoutSucceeded}:${session.id}`,
        $set: {
          last_checkout_succeeded_at: new Date().toISOString(),
        },
      }),
    );
  }

  await awardReferralConversion({
    tier: resolved.tier,
    subscription: resolved.subscription,
    customerId,
    plan: price?.lookup_key ?? undefined,
    checkoutSessionId: session.id,
    checkoutAttemptId,
  });
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

  const { userIds, orgId } = await resolveUserIdsFromCustomer(customerId);
  if (userIds.length === 0) {
    console.error(
      `[Subscription Webhook] subscription.updated: could not resolve users for customer ${customerId}`,
    );
    return;
  }

  console.log(
    `[Subscription Webhook] subscription.updated: tier change ${previousTier} → ${currentTier} for ${userIds.length} user(s)`,
  );

  const direction = tierDirection(previousTier, currentTier);
  const checkoutAttemptId = metadataString(
    subscription.metadata,
    "checkoutAttemptId",
  );
  const checkoutSource = metadataString(
    subscription.metadata,
    "checkoutSource",
  );
  const checkoutSurface = metadataString(
    subscription.metadata,
    "checkoutSurface",
  );
  for (const uid of userIds) {
    phLogger.event("subscription_changed", {
      userId: uid,
      from_tier: previousTier,
      to_tier: currentTier,
      direction,
      org_id: orgId,
      checkout_attempt_id: checkoutAttemptId,
      surface: checkoutSurface,
      source: checkoutSource,
      plan: currentLookupKey,
      billing_interval: priceBillingInterval(currentPrice),
      // Only update the person property when we resolved the new tier. A null
      // currentTier means Stripe's lookup_key + product fallbacks both failed,
      // and coercing to "free" would silently move possibly-paid users out of
      // the paid cohort.
      ...(currentTier && { $set: { subscription_tier: currentTier } }),
    });
  }

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

/** Handle customer.subscription.deleted — emit churn analytics for the lapsed paid users. */
async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
): Promise<void> {
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id;
  if (!customerId) return;

  const lookupKey = subscription.items?.data[0]?.price?.lookup_key ?? null;
  const tier = lookupKey ? planLookupKeyToTier(lookupKey) : null;

  const { userIds, orgId } = await resolveUserIdsFromCustomer(customerId);
  if (userIds.length === 0) {
    console.error(
      `[Subscription Webhook] subscription.deleted: could not resolve users for customer ${customerId}`,
    );
    return;
  }

  const cancellationReason = subscription.cancellation_details?.reason ?? null;

  console.log(
    `[Subscription Webhook] subscription.deleted: tier ${tier ?? "unknown"} cancelled for ${userIds.length} user(s) (reason: ${cancellationReason ?? "none"})`,
  );

  for (const uid of userIds) {
    phLogger.event("subscription_cancelled", {
      userId: uid,
      tier,
      org_id: orgId,
      cancellation_reason: cancellationReason,
      $set: { subscription_tier: "free" },
    });
  }

  await setReferralCodesPaidEligibility({
    userIds,
    active: false,
  });
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
 * - Events: checkout.session.completed, invoice.paid,
 *   customer.subscription.updated, customer.subscription.deleted
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
    case "checkout.session.completed": {
      await handleCheckoutSessionCompleted(
        event.data.object as Stripe.Checkout.Session,
      );
      break;
    }
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
    case "customer.subscription.deleted": {
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
      break;
    }
  }

  // Flush queued PostHog events after the response is sent. Webhook handlers
  // terminate quickly enough that buffered events would otherwise be dropped.
  after(() => phLogger.flush());

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
