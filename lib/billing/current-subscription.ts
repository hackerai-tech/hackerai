import type Stripe from "stripe";

import { stripe } from "@/app/api/stripe";
import { planLookupKeyToTier } from "@/lib/analytics/paid-funnel";
import { priceBillingInterval } from "@/lib/billing/subscription-mrr";
import { stripeObjectId } from "@/lib/billing/subscription-payment-failure";
import {
  proMonthlyPricingAssignmentFromMetadata,
  type ProMonthlyPricingExperimentAssignment,
} from "@/lib/experiments/pro-monthly-pricing";
import type { SubscriptionTier } from "@/types";

export const NO_ACTIVE_SUBSCRIPTION_ERROR = "No active subscription found";

/** Statuses that still represent the customer's current subscription. */
export const CURRENT_SUBSCRIPTION_STATUSES: ReadonlySet<Stripe.Subscription.Status> =
  new Set(["active", "trialing", "past_due", "unpaid"]);

export type CurrentSubscriptionContext = {
  id: string;
  status: Stripe.Subscription.Status;
  cancelAtPeriodEnd: boolean;
  itemId?: string;
  /** Attached Stripe schedule, when a plan change is pending. */
  scheduleId?: string;
  priceId?: string;
  plan?: string;
  tier?: SubscriptionTier;
  billingInterval?: "day" | "week" | "month" | "year";
  billingIntervalCount?: number;
  unitAmountDollars?: number;
  currency?: string;
  quantity: number;
  currentPeriodEndMs?: number;
  metadata: Stripe.Metadata;
  defaultPaymentMethodId?: string;
  latestInvoiceId?: string;
  pricingExperiment?: ProMonthlyPricingExperimentAssignment;
  subscription: Stripe.Subscription;
};

/** Paid-through timestamp in ms. Stripe moved the period onto items in 2025. */
export function subscriptionCurrentPeriodEndMs(
  subscription: Stripe.Subscription,
): number | undefined {
  const itemPeriodEnds = (subscription.items?.data ?? [])
    .map(
      (item) => (item as { current_period_end?: unknown }).current_period_end,
    )
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value > 0,
    );
  if (itemPeriodEnds.length > 0) {
    return Math.max(...itemPeriodEnds) * 1000;
  }

  const periodEnd = (subscription as { current_period_end?: unknown })
    .current_period_end;
  return typeof periodEnd === "number" &&
    Number.isFinite(periodEnd) &&
    periodEnd > 0
    ? periodEnd * 1000
    : undefined;
}

export function subscriptionTierFromLookupKey(
  lookupKey: string | null | undefined,
): SubscriptionTier | undefined {
  return planLookupKeyToTier(lookupKey ?? undefined) ?? undefined;
}

export function toCurrentSubscriptionContext(
  subscription: Stripe.Subscription,
): CurrentSubscriptionContext {
  const item = subscription.items?.data[0];
  const price = item?.price;
  const unitAmountDollars =
    typeof price?.unit_amount === "number"
      ? price.unit_amount / 100
      : undefined;

  return {
    id: subscription.id,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    itemId: item?.id,
    scheduleId: stripeObjectId(subscription.schedule ?? undefined) ?? undefined,
    priceId: price?.id,
    plan: price?.lookup_key ?? undefined,
    tier: subscriptionTierFromLookupKey(price?.lookup_key),
    billingInterval: priceBillingInterval(price),
    billingIntervalCount: price?.recurring?.interval_count ?? undefined,
    unitAmountDollars,
    currency: price?.currency,
    quantity: item?.quantity ?? 1,
    currentPeriodEndMs: subscriptionCurrentPeriodEndMs(subscription),
    metadata: subscription.metadata ?? {},
    defaultPaymentMethodId:
      stripeObjectId(subscription.default_payment_method) ?? undefined,
    latestInvoiceId: stripeObjectId(subscription.latest_invoice) ?? undefined,
    pricingExperiment: proMonthlyPricingAssignmentFromMetadata(
      subscription.metadata,
      price?.lookup_key,
    ),
    subscription,
  };
}

/**
 * Load the customer's current subscription. Throws the shared
 * "No active subscription found" error when the customer has none.
 */
export async function getCurrentSubscriptionContext(
  stripeCustomerId: string,
): Promise<CurrentSubscriptionContext> {
  const subscriptions = await stripe.subscriptions.list({
    customer: stripeCustomerId,
    status: "all",
    limit: 10,
    expand: ["data.items.data.price"],
  });
  const current = subscriptions.data.find((subscription) =>
    CURRENT_SUBSCRIPTION_STATUSES.has(subscription.status),
  );

  if (!current) {
    throw new Error(NO_ACTIVE_SUBSCRIPTION_ERROR);
  }

  return toCurrentSubscriptionContext(current);
}
