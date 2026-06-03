import type Stripe from "stripe";

type BillingInterval = "day" | "week" | "month" | "year";

export function priceBillingInterval(
  price: Stripe.Price | undefined,
): BillingInterval | undefined {
  return price?.recurring?.interval ?? undefined;
}

function priceAmountDollars(
  price: Stripe.Price | undefined,
): number | undefined {
  if (typeof price?.unit_amount === "number") return price.unit_amount / 100;

  const decimalAmount = Number(price?.unit_amount_decimal);
  return Number.isFinite(decimalAmount) ? decimalAmount / 100 : undefined;
}

function recurringIntervalMonths(
  interval: BillingInterval | undefined,
  intervalCount = 1,
): number | undefined {
  if (!interval || intervalCount <= 0) return undefined;
  const averageDaysPerMonth = 365 / 12;

  switch (interval) {
    case "day":
      return intervalCount / averageDaysPerMonth;
    case "week":
      return (intervalCount * 7) / averageDaysPerMonth;
    case "month":
      return intervalCount;
    case "year":
      return intervalCount * 12;
  }
}

export function subscriptionMrrDollars({
  price,
  quantity = 1,
  fallbackIntervalAmountDollars,
}: {
  price: Stripe.Price | undefined;
  quantity?: number;
  fallbackIntervalAmountDollars?: number;
}): number | undefined {
  const amountDollars =
    priceAmountDollars(price) ?? fallbackIntervalAmountDollars;
  const intervalMonths = recurringIntervalMonths(
    priceBillingInterval(price),
    price?.recurring?.interval_count ?? 1,
  );

  if (amountDollars === undefined || intervalMonths === undefined) {
    return undefined;
  }

  return (amountDollars * quantity) / intervalMonths;
}
