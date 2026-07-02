"use server";

import { stripe } from "../../app/api/stripe";
import { getBillingActionContext } from "@/lib/actions/billing-context";

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
  const { stripeCustomerId } = await getBillingActionContext();
  const subscriptions = await stripe.subscriptions.list({
    customer: stripeCustomerId,
    status: "all",
    limit: 10,
  });
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
