import type Stripe from "stripe";
import { subscriptionTierFromPrice } from "./current-subscription";

/** A same-tier annual switch must not override a payment or retention decision. */
export function annualSwitchTier(subscription: Stripe.Subscription) {
  const item = subscription.items?.data[0];
  const tier = subscriptionTierFromPrice(item?.price);
  const invoice = subscription.latest_invoice;
  if (
    subscription.status !== "active" ||
    subscription.collection_method !== "charge_automatically" ||
    subscription.cancel_at_period_end ||
    subscription.cancel_at ||
    subscription.pause_collection ||
    subscription.pending_update ||
    subscription.schedule ||
    !item ||
    subscription.items?.has_more ||
    subscription.items?.data.length !== 1 ||
    item?.quantity !== 1 ||
    item.price.currency !== "usd" ||
    item.price.recurring?.interval !== "month" ||
    item.price.recurring.interval_count !== 1 ||
    item.price.recurring.usage_type !== "licensed" ||
    !invoice ||
    typeof invoice === "string" ||
    invoice.status !== "paid" ||
    (tier !== "pro" && tier !== "pro-plus" && tier !== "ultra")
  )
    return null;
  return tier;
}

export type AnnualSwitchQuote = {
  subscriptionId: string;
  currentPriceId: string;
  targetPriceId: string;
  prorationDate: number;
  amountDue: number;
  currency: string;
};
