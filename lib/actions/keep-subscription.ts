"use server";

import { stripe } from "../../app/api/stripe";
import { api } from "@/convex/_generated/api";
import { getBillingActionContext } from "@/lib/actions/billing-context";
import { phLogger } from "@/lib/posthog/server";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
  planLookupKeyToTier,
} from "@/lib/analytics/paid-funnel";
import type { KeepSubscriptionResult } from "@/lib/billing/api-types";
import {
  clearedSubscriptionPauseMetadata,
  subscriptionPauseFromMetadata,
  type SubscriptionPauseMetadata,
} from "@/lib/billing/retention-offers";
import { subscriptionCurrentPeriodEndMs } from "@/lib/billing/current-subscription";
import { getConvexClient } from "@/lib/db/convex-client";
import type Stripe from "stripe";
import type { SubscriptionTier } from "@/types";

type SubscriptionContext = {
  id: string;
  priceId?: string;
  plan?: string;
  tier?: SubscriptionTier;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd: boolean;
  pause: SubscriptionPauseMetadata | null;
};

export type { KeepSubscriptionResult };

function subscriptionTierFromLookupKey(
  lookupKey: string | null | undefined,
): SubscriptionTier | undefined {
  return planLookupKeyToTier(lookupKey ?? undefined) ?? undefined;
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
    currentPeriodEnd: subscriptionCurrentPeriodEndMs(currentSubscription),
    cancelAtPeriodEnd: currentSubscription.cancel_at_period_end === true,
    pause: subscriptionPauseFromMetadata(currentSubscription.metadata),
  };
}

async function cancelScheduledPauseRecord(args: {
  subscriptionId: string;
  userId: string;
  organizationId: string;
  stripeCustomerId: string;
}): Promise<boolean> {
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  if (!serviceKey) return false;

  try {
    const result = await getConvexClient().mutation(
      api.subscriptionPauses.cancelScheduledPause,
      {
        serviceKey,
        stripeSubscriptionId: args.subscriptionId,
        canceledAt: Date.now(),
      },
    );
    return result.canceledCount > 0;
  } catch (error) {
    phLogger.warn("subscription_pause_cancel_record_failed", {
      userId: args.userId,
      org_id: args.organizationId,
      stripe_customer_id: args.stripeCustomerId,
      stripe_subscription_id: args.subscriptionId,
      error,
    });
    return false;
  }
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

  const pause = subscriptionContext.pause;
  if (pause && !process.env.CONVEX_SERVICE_ROLE_KEY) {
    // Clearing the Stripe pause without cancelling the Convex record would
    // leave a scheduled resume behind; refuse rather than diverge.
    const error = new Error("CONVEX_SERVICE_ROLE_KEY is not set");
    phLogger.error("subscription_pause_cancel_misconfigured", {
      userId: user.id,
      org_id: organizationId,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: subscriptionContext.id,
      error,
    });
    throw error;
  }
  const updatedSubscription = await stripe.subscriptions.update(
    subscriptionContext.id,
    {
      cancel_at_period_end: false,
      ...(pause && { metadata: clearedSubscriptionPauseMetadata() }),
    },
  );

  let pauseCanceled = false;
  if (pause) {
    pauseCanceled = await cancelScheduledPauseRecord({
      subscriptionId: subscriptionContext.id,
      userId: user.id,
      organizationId,
      stripeCustomerId,
    });
    phLogger.event(
      PAID_FUNNEL_EVENTS.subscriptionPauseCanceled,
      paidFunnelProperties({
        userId: user.id,
        org_id: organizationId,
        subscription_tier: subscriptionContext.tier,
        plan: subscriptionContext.plan,
        pause_months: pause.months,
        pause_resume_at: new Date(pause.resumeAtMs).toISOString(),
        pause_id: pause.pauseId,
        pause_record_canceled: pauseCanceled,
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: subscriptionContext.id,
        stripe_price_id: subscriptionContext.priceId,
        $insert_id: `${PAID_FUNNEL_EVENTS.subscriptionPauseCanceled}:${subscriptionContext.id}:${pause.pauseId ?? pause.resumeAtMs}`,
      }),
    );
  }

  phLogger.event(
    PAID_FUNNEL_EVENTS.cancellationReversed,
    paidFunnelProperties({
      userId: user.id,
      org_id: organizationId,
      subscription_tier: subscriptionContext.tier,
      plan: subscriptionContext.plan,
      cancellation_reversal_type: "in_app",
      cancel_at_period_end: updatedSubscription.cancel_at_period_end,
      ...(pause && { retention_pause: true }),
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
      subscriptionCurrentPeriodEndMs(updatedSubscription) ??
      subscriptionContext.currentPeriodEnd,
    alreadyKept: false,
    ...(pause && { pauseCanceled }),
  };
}
