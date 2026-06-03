import type Stripe from "stripe";

type BillingInterval = "day" | "week" | "month" | "year";

function finitePositive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function priceBillingInterval(
  price: Stripe.Price | undefined,
): BillingInterval | undefined {
  return price?.recurring?.interval ?? undefined;
}

function priceAmountDollars(
  price: Stripe.Price | undefined,
): number | undefined {
  if (typeof price?.unit_amount === "number") {
    const amountDollars = price.unit_amount / 100;
    return finitePositive(amountDollars) ? amountDollars : undefined;
  }

  if (price?.unit_amount_decimal == null) return undefined;

  const decimalAmount = Number(price.unit_amount_decimal);
  const amountDollars = decimalAmount / 100;
  return finitePositive(amountDollars) ? amountDollars : undefined;
}

function recurringIntervalMonths(
  interval: BillingInterval | undefined,
  intervalCount = 1,
): number | undefined {
  if (!interval || !finitePositive(intervalCount)) return undefined;
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
  fallbackTotalIntervalAmountDollars,
}: {
  price: Stripe.Price | undefined;
  quantity?: number;
  fallbackTotalIntervalAmountDollars?: number;
}): number | undefined {
  if (!finitePositive(quantity)) return undefined;

  const unitAmountDollars = priceAmountDollars(price);
  const totalIntervalAmountDollars =
    unitAmountDollars === undefined
      ? fallbackTotalIntervalAmountDollars
      : unitAmountDollars * quantity;
  const intervalMonths = recurringIntervalMonths(
    priceBillingInterval(price),
    price?.recurring?.interval_count ?? 1,
  );

  if (
    !finitePositive(totalIntervalAmountDollars) ||
    !finitePositive(intervalMonths)
  ) {
    return undefined;
  }

  return totalIntervalAmountDollars / intervalMonths;
}
