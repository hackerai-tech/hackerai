import type Stripe from "stripe";

import { PRICING } from "./config";

export const PRO_MONTHLY_PRICE_LOOKUP_KEY = "pro-monthly-plan";
/** Immutable $49 Price offered only to accounts assigned by HAC-248. */
export const PRO_MONTHLY_49_PRICE_LOOKUP_KEY = "pro-monthly-plan-49-hac248";
export const PRO_MONTHLY_49_AMOUNT_DOLLARS = 49;
/** Immutable live Stripe Price retained by subscribers who joined at $25. */
export const GRANDFATHERED_PRO_MONTHLY_PRICE_ID =
  "price_1S0pbLFAn4ulhcn18Ld9qiRm";

export type ProMonthlyPriceLookupKey =
  typeof PRO_MONTHLY_PRICE_LOOKUP_KEY | typeof PRO_MONTHLY_49_PRICE_LOOKUP_KEY;

export type ProMonthlyAmountDollars =
  typeof PRICING.pro.monthly | typeof PRO_MONTHLY_49_AMOUNT_DOLLARS;

/** An authoritative monthly Pro price quote for one account. */
export type ProMonthlyPricePresentation = {
  priceLookupKey: ProMonthlyPriceLookupKey;
  displayedAmountDollars: ProMonthlyAmountDollars;
  currency: "usd";
  billingInterval: "month";
  stripePriceId: string;
};

const AMOUNT_BY_LOOKUP_KEY: Record<
  ProMonthlyPriceLookupKey,
  ProMonthlyAmountDollars
> = {
  [PRO_MONTHLY_PRICE_LOOKUP_KEY]: PRICING.pro.monthly,
  [PRO_MONTHLY_49_PRICE_LOOKUP_KEY]: PRO_MONTHLY_49_AMOUNT_DOLLARS,
};

function isMonthlyLicensedUsdPrice(price: Stripe.Price, amountCents: number) {
  return (
    price.active &&
    price.currency === "usd" &&
    price.unit_amount === amountCents &&
    price.billing_scheme === "per_unit" &&
    price.type === "recurring" &&
    price.recurring?.interval === "month" &&
    price.recurring.interval_count === 1 &&
    price.recurring.usage_type === "licensed"
  );
}

export function stripePriceProductId(
  price: Pick<Stripe.Price, "product"> | undefined,
): string | undefined {
  const product = price?.product;
  if (typeof product === "string") return product || undefined;
  return product && typeof product.id === "string" ? product.id : undefined;
}

/** Reject a mismatched Stripe Price before displaying it or opening checkout. */
export function isCurrentProMonthlyPrice(
  price: Stripe.Price | undefined,
): boolean {
  return Boolean(
    price &&
    price.lookup_key === PRO_MONTHLY_PRICE_LOOKUP_KEY &&
    isMonthlyLicensedUsdPrice(price, PRICING.pro.monthly * 100),
  );
}

/**
 * The $49 Price must sell the same Product as the $29 control so entitlements
 * and included usage cannot differ between variants.
 */
export function isProMonthly49Price(
  price: Stripe.Price | undefined,
  controlProductId: string | undefined,
): boolean {
  if (!price || !controlProductId) return false;
  const recurring = price.recurring as
    (Stripe.Price.Recurring & { trial_period_days?: number | null }) | null;
  return Boolean(
    price.lookup_key === PRO_MONTHLY_49_PRICE_LOOKUP_KEY &&
    isMonthlyLicensedUsdPrice(price, PRO_MONTHLY_49_AMOUNT_DOLLARS * 100) &&
    stripePriceProductId(price) === controlProductId &&
    !recurring?.trial_period_days &&
    !price.custom_unit_amount &&
    !price.transform_quantity &&
    !price.tiers_mode,
  );
}

export function proMonthlyPricePresentation(
  price: Stripe.Price,
): ProMonthlyPricePresentation {
  const priceLookupKey =
    price.lookup_key === PRO_MONTHLY_49_PRICE_LOOKUP_KEY
      ? PRO_MONTHLY_49_PRICE_LOOKUP_KEY
      : PRO_MONTHLY_PRICE_LOOKUP_KEY;
  return {
    priceLookupKey,
    displayedAmountDollars: AMOUNT_BY_LOOKUP_KEY[priceLookupKey],
    currency: "usd",
    billingInterval: "month",
    stripePriceId: price.id,
  };
}

/** Client-safe parser: the amount must be the one sold under its lookup key. */
export function parseProMonthlyPricePresentation(
  value: unknown,
): ProMonthlyPricePresentation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const lookupKey = candidate.priceLookupKey;
  if (
    lookupKey !== PRO_MONTHLY_PRICE_LOOKUP_KEY &&
    lookupKey !== PRO_MONTHLY_49_PRICE_LOOKUP_KEY
  ) {
    return undefined;
  }
  if (
    candidate.displayedAmountDollars !== AMOUNT_BY_LOOKUP_KEY[lookupKey] ||
    candidate.currency !== "usd" ||
    candidate.billingInterval !== "month" ||
    typeof candidate.stripePriceId !== "string" ||
    !candidate.stripePriceId.startsWith("price_")
  ) {
    return undefined;
  }
  return {
    priceLookupKey: lookupKey,
    displayedAmountDollars: AMOUNT_BY_LOOKUP_KEY[lookupKey],
    currency: "usd",
    billingInterval: "month",
    stripePriceId: candidate.stripePriceId,
  };
}
