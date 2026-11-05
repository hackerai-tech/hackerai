import type Stripe from "stripe";

import { PRICING } from "./config";

export const PRO_MONTHLY_PRICE_LOOKUP_KEY = "pro-monthly-plan";
/** Immutable live Stripe Price retained by subscribers who joined at $25. */
export const GRANDFATHERED_PRO_MONTHLY_PRICE_ID =
  "price_1S0pbLFAn4ulhcn18Ld9qiRm";

export type ProMonthlyPricePresentation = {
  priceLookupKey: typeof PRO_MONTHLY_PRICE_LOOKUP_KEY;
  displayedAmountDollars: number;
  currency: "usd";
  billingInterval: "month";
  stripePriceId: string;
};

/** Reject a mismatched Stripe Price before displaying it or opening checkout. */
export function isCurrentProMonthlyPrice(
  price: Stripe.Price | undefined,
): boolean {
  return Boolean(
    price &&
    price.active &&
    price.lookup_key === PRO_MONTHLY_PRICE_LOOKUP_KEY &&
    price.currency === "usd" &&
    price.unit_amount === PRICING.pro.monthly * 100 &&
    price.billing_scheme === "per_unit" &&
    price.type === "recurring" &&
    price.recurring?.interval === "month" &&
    price.recurring.interval_count === 1 &&
    price.recurring.usage_type === "licensed",
  );
}

export function proMonthlyPricePresentation(
  price: Stripe.Price,
): ProMonthlyPricePresentation {
  return {
    priceLookupKey: PRO_MONTHLY_PRICE_LOOKUP_KEY,
    displayedAmountDollars: PRICING.pro.monthly,
    currency: "usd",
    billingInterval: "month",
    stripePriceId: price.id,
  };
}
