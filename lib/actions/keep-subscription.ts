"use server";

import { stripe } from "../../app/api/stripe";
import { getBillingActionContext } from "@/lib/actions/billing-context";
import { phLogger } from "@/lib/posthog/server";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
  planLookupKeyToTier,
} from "@/lib/analytics/paid-funnel";
import type Stripe from "stripe";
import type { SubscriptionTier } from "@/types";

type SubscriptionContext = {
  id: string;
  priceId?: string;
  plan?: string;
  tier?: SubscriptionTier;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd: boolean;
};

export type KeepSubscriptionResult = {
  kept: true;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd?: number;
  alreadyKept: boolean;
};

function subscriptionTierFromLookupKey(
  lookupKey: string | null | undefined,
): SubscriptionTier | undefined {
  return planLookupKeyToTier(lookupKey ?? undefined) ?? undefined;
}

function currentPeriodEndMs(subscription: unknown): number | undefined {
  const currentPeriodEnd = (subscription as { current_period_end?: unknown })
    .current_period_end;
  return typeof currentPeriodEnd === "number" &&
    Number.isFinite(currentPeriodEnd) &&
    currentPeriodEnd > 0
    ? currentPeriodEnd * 1000
    : undefined;
}

async function getActiveSubscriptionContext(
  stripeCustomerId: string,
): Promise<SubscriptionContext> {
  const subscriptions = stripe.subscriptions.list({
    customer: stripeCustomerId,
    status: "all",
    limit: 100,
    expand: ["data.items.data.price"],
  });
  let currentSubscription: Stripe.Subscription | undefined;
  for await (const subscription of subscriptions) {
    if (
      ["active", "trialing", "past_due", "unpaid"].includes(subscription.status)
    ) {
      currentSubscription = subscription;
      break;
    }
  }

  if (!currentSubscription) {
    throw new Error("No active subscription found");
  }

  const price = currentSubscription.items.data[0]?.price;
  return {
    id: currentSubscription.id,
    priceId: price?.id,
    plan: price?.lookup_key ?? undefined,
    tier: subscriptionTierFromLookupKey(price?.lookup_key),
    currentPeriodEnd: currentPeriodEndMs(currentSubscription),
    cancelAtPeriodEnd: currentSubscription.cancel_at_period_end === true,
  };
}

export default async function keepSubscriptionAction(): Promise<KeepSubscriptionResult> {
  const { organizationId, user, stripeCustomerId } =
    await getBillingActionContext();
  const subscriptionContext =
    await getActiveSubscriptionContext(stripeCustomerId);

  if (!subscriptionContext.cancelAtPeriodEnd) {
    return {
      kept: true,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: subscriptionContext.currentPeriodEnd,
      alreadyKept: true,
    };
  }

  const updatedSubscription = await stripe.subscriptions.update(
    subscriptionContext.id,
    {
      cancel_at_period_end: false,
    },
  );

  phLogger.event(
    PAID_FUNNEL_EVENTS.cancellationReversed,
    paidFunnelProperties({
      userId: user.id,
      org_id: organizationId,
      subscription_tier: subscriptionContext.tier,
      plan: subscriptionContext.plan,
      cancellation_reversal_type: "in_app",
      cancel_at_period_end: updatedSubscription.cancel_at_period_end,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: subscriptionContext.id,
      stripe_price_id: subscriptionContext.priceId,
      $insert_id: `${PAID_FUNNEL_EVENTS.cancellationReversed}:${subscriptionContext.id}:in_app`,
    }),
  );

  return {
    kept: true,
    cancelAtPeriodEnd: updatedSubscription.cancel_at_period_end === true,
    currentPeriodEnd:
      currentPeriodEndMs(updatedSubscription) ??
      subscriptionContext.currentPeriodEnd,
    alreadyKept: false,
  };
}
