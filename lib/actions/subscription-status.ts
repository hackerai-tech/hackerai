"use server";

import { stripe } from "../../app/api/stripe";
import { getBillingActionContext } from "@/lib/actions/billing-context";
import { phLogger } from "@/lib/posthog/server";

export type SubscriptionCancellationStatus = {
  hasActiveSubscription: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd?: number;
};

function currentPeriodEndMs(subscription: unknown): number | undefined {
  const currentPeriodEnd = (subscription as { current_period_end?: unknown })
    .current_period_end;
  return typeof currentPeriodEnd === "number" &&
    Number.isFinite(currentPeriodEnd) &&
    currentPeriodEnd > 0
    ? currentPeriodEnd * 1000
    : undefined;
}

export default async function getSubscriptionCancellationStatusAction(): Promise<SubscriptionCancellationStatus> {
  const startedAt = Date.now();
  const context = await getBillingActionContext().catch((error) => {
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
  const currentSubscription = subscriptions.data.find((subscription) =>
    ["active", "trialing", "past_due", "unpaid"].includes(subscription.status),
  );

  if (!currentSubscription) {
    return {
      hasActiveSubscription: false,
      cancelAtPeriodEnd: false,
    };
  }

  return {
    hasActiveSubscription: true,
    cancelAtPeriodEnd: currentSubscription.cancel_at_period_end === true,
    currentPeriodEnd: currentPeriodEndMs(currentSubscription),
  };
}
