"use server";

import { stripe } from "../../app/api/stripe";
import { isExpectedBillingContextError } from "@/lib/actions/billing-action-errors";
import { getBillingActionContext } from "@/lib/actions/billing-context";
import { phLogger } from "@/lib/posthog/server";
import type { SubscriptionCancellationStatus } from "@/lib/billing/api-types";
import { subscriptionCurrentPeriodEndMs } from "@/lib/billing/current-subscription";
import { subscriptionPauseFromMetadata } from "@/lib/billing/retention-offers";
import { resolvePendingPlanChange } from "@/lib/billing/subscription-schedule";
import { planLookupKeyToTier } from "@/lib/analytics/paid-funnel";
import { stripeObjectId } from "@/lib/billing/subscription-payment-failure";

type CurrentSubscriptionStatus = NonNullable<
  SubscriptionCancellationStatus["subscriptionStatus"]
>;

function isCurrentSubscriptionStatus(
  status: string,
): status is CurrentSubscriptionStatus {
  return ["active", "trialing", "past_due", "unpaid"].includes(status);
}

function hasCurrentSubscriptionStatus<T extends { status: string }>(
  subscription: T,
): subscription is T & { status: CurrentSubscriptionStatus } {
  return isCurrentSubscriptionStatus(subscription.status);
}

export default async function getSubscriptionCancellationStatusAction(): Promise<SubscriptionCancellationStatus> {
  const startedAt = Date.now();
  const context = await getBillingActionContext().catch((error) => {
    if (isExpectedBillingContextError(error)) {
      throw error;
    }

    phLogger.error("billing_subscription_status_action_failed", {
      event: "billing_subscription_status_action_failed",
      stage: "billing_context",
      duration_ms: Date.now() - startedAt,
      error,
    });
    throw error;
  });
  const stripeCustomerId = context.stripeCustomerId;
  const billingFields = {
    userId: context.user.id,
    org_id: context.organizationId,
    stripe_customer_id: stripeCustomerId,
  };

  let subscriptions: Awaited<ReturnType<typeof stripe.subscriptions.list>>;
  try {
    subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: "all",
      limit: 10,
      expand: ["data.items.data.price", "data.schedule", "data.latest_invoice"],
    });
  } catch (error) {
    phLogger.error("billing_subscription_status_action_failed", {
      event: "billing_subscription_status_action_failed",
      ...billingFields,
      stage: "stripe_subscription_list",
      duration_ms: Date.now() - startedAt,
      error,
    });
    throw error;
  }
  const currentSubscriptions = subscriptions.data.filter(
    hasCurrentSubscriptionStatus,
  );
  // A customer can temporarily retain overlapping subscriptions after checkout
  // or migration. Never choose a card-recovery target from ambiguous or partial
  // history; both Account settings and blocked chat must request billing review.
  if (subscriptions.has_more || currentSubscriptions.length > 1) {
    throw new Error("Unable to determine a single current subscription");
  }
  const currentSubscription = currentSubscriptions[0];

  if (!currentSubscription) {
    return {
      hasActiveSubscription: false,
      cancelAtPeriodEnd: false,
    };
  }

  const invoice = currentSubscription.latest_invoice;
  const renewalPaymentRequired =
    ["past_due", "unpaid"].includes(currentSubscription.status) &&
    currentSubscription.collection_method === "charge_automatically" &&
    !currentSubscription.cancel_at_period_end &&
    !currentSubscription.cancel_at &&
    !currentSubscription.pause_collection &&
    typeof invoice === "object" &&
    invoice !== null &&
    invoice.status === "open" &&
    invoice.collection_method === "charge_automatically" &&
    invoice.billing_reason === "subscription_cycle" &&
    invoice.amount_remaining > 0;
  const latestInvoiceId = stripeObjectId(currentSubscription.latest_invoice);
  const item = currentSubscription.items?.data[0];
  const price = item?.price;
  const renewalAmountDollars =
    price?.unit_amount == null
      ? undefined
      : (price.unit_amount * (item.quantity ?? 1)) / 100;
  const cancelAtPeriodEnd = currentSubscription.cancel_at_period_end === true;
  const currentPeriodEnd = subscriptionCurrentPeriodEndMs(currentSubscription);
  const pause = cancelAtPeriodEnd
    ? subscriptionPauseFromMetadata(currentSubscription.metadata)
    : null;
  const pendingChange = await resolvePendingPlanChange(
    currentSubscription.schedule,
    price?.id,
  );
  const pendingPrice = pendingChange?.price;
  return {
    hasActiveSubscription: true,
    cancelAtPeriodEnd,
    currentPeriodEnd,
    subscriptionStatus: currentSubscription.status,
    ...(pause && {
      pause: {
        months: pause.months,
        resumeAt: pause.resumeAtMs,
        ...(currentPeriodEnd && { pauseEffectiveAt: currentPeriodEnd }),
      },
    }),
    ...(pendingChange && {
      pendingPlanChange: {
        effectiveAt: pendingChange.effectiveAtMs,
        ...(pendingPrice?.lookup_key && {
          targetPlan: pendingPrice.lookup_key,
          targetTier: planLookupKeyToTier(pendingPrice.lookup_key) ?? undefined,
        }),
        ...(typeof pendingPrice?.unit_amount === "number" && {
          targetAmountDollars: pendingPrice.unit_amount / 100,
        }),
        ...(pendingPrice?.currency && { currency: pendingPrice.currency }),
      },
    }),
    ...(latestInvoiceId && { latestInvoiceId }),
    ...(renewalPaymentRequired && { renewalPaymentRequired: true }),
    ...(price?.id && { stripePriceId: price.id }),
    ...(price?.lookup_key && { stripePriceLookupKey: price.lookup_key }),
    ...(renewalAmountDollars !== undefined && { renewalAmountDollars }),
    ...(price?.currency && { renewalCurrency: price.currency }),
    ...(price?.recurring?.interval && {
      renewalInterval: price.recurring.interval,
    }),
    ...(price?.recurring?.interval_count && {
      renewalIntervalCount: price.recurring.interval_count,
    }),
  };
}
