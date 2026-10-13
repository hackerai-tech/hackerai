import type Stripe from "stripe";

import { PRICING } from "./config";

export const PRO_YEARLY_PRICE_LOOKUP_KEY = "pro-yearly-plan";
/** Keep existing $252 annual subscribers recognizable after lookup transfer. */
export const GRANDFATHERED_PRO_YEARLY_PRICE_ID =
  "price_1SkSysFAn4ulhcn12S2VkmkJ";

export function isCurrentProYearlyPrice(
  price: Stripe.Price | undefined,
): boolean {
  return Boolean(
    price &&
    price.active &&
    price.lookup_key === PRO_YEARLY_PRICE_LOOKUP_KEY &&
    price.currency === "usd" &&
    price.unit_amount === PRICING.pro.yearly * 12 * 100 &&
    price.billing_scheme === "per_unit" &&
    price.type === "recurring" &&
    price.recurring?.interval === "year" &&
    price.recurring.interval_count === 1 &&
    price.recurring.usage_type === "licensed",
  );
}
