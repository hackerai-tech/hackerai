import { describe, expect, it } from "@jest/globals";
import {
  priceBillingInterval,
  subscriptionMrrDollars,
} from "../subscription-mrr";

function price({
  amountCents,
  amountDecimal,
  interval,
  intervalCount = 1,
}: {
  amountCents?: number;
  amountDecimal?: string | null;
  interval: "day" | "week" | "month" | "year";
  intervalCount?: number;
}) {
  return {
    unit_amount: amountCents,
    unit_amount_decimal: amountDecimal,
    recurring: {
      interval,
      interval_count: intervalCount,
    },
  } as any;
}

describe("subscription MRR normalization", () => {
  it("keeps monthly subscription price as monthly revenue", () => {
    expect(
      subscriptionMrrDollars({
        price: price({ amountCents: 2500, interval: "month" }),
      }),
    ).toBe(25);
  });

  it("normalizes annual subscription price over twelve months", () => {
    expect(
      subscriptionMrrDollars({
        price: price({ amountCents: 25200, interval: "year" }),
      }),
    ).toBe(21);
  });

  it("includes subscription quantity in normalized MRR", () => {
    expect(
      subscriptionMrrDollars({
        price: price({ amountCents: 6000, interval: "month" }),
        quantity: 3,
      }),
    ).toBe(180);
  });

  it("uses fallback total amount only when the price amount is unavailable", () => {
    expect(
      subscriptionMrrDollars({
        price: price({ interval: "year" }),
        fallbackTotalIntervalAmountDollars: 120,
      }),
    ).toBe(10);
  });

  it("does not multiply fallback invoice totals by quantity again", () => {
    expect(
      subscriptionMrrDollars({
        price: price({ interval: "year" }),
        quantity: 5,
        fallbackTotalIntervalAmountDollars: 1200,
      }),
    ).toBe(100);
  });

  it("does not coerce nullable Stripe decimal amounts into zero MRR", () => {
    expect(
      subscriptionMrrDollars({
        price: price({ amountDecimal: null, interval: "month" }),
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the billing cadence is missing or invalid", () => {
    expect(
      subscriptionMrrDollars({
        price: undefined,
        fallbackTotalIntervalAmountDollars: 120,
      }),
    ).toBeUndefined();
    expect(
      subscriptionMrrDollars({
        price: price({
          amountCents: 12000,
          interval: "month",
          intervalCount: 0,
        }),
      }),
    ).toBeUndefined();
  });

  it("returns undefined for invalid numeric inputs", () => {
    expect(
      subscriptionMrrDollars({
        price: price({ amountCents: 2500, interval: "month" }),
        quantity: Number.NaN,
      }),
    ).toBeUndefined();
    expect(
      subscriptionMrrDollars({
        price: price({ amountCents: 2500, interval: "month" }),
        quantity: -1,
      }),
    ).toBeUndefined();
    expect(
      subscriptionMrrDollars({
        price: price({ interval: "month" }),
        fallbackTotalIntervalAmountDollars: Number.POSITIVE_INFINITY,
      }),
    ).toBeUndefined();
    expect(
      subscriptionMrrDollars({
        price: price({ amountCents: 0, interval: "month" }),
      }),
    ).toBeUndefined();
    expect(
      subscriptionMrrDollars({
        price: price({
          amountCents: 2500,
          interval: "month",
          intervalCount: Number.NaN,
        }),
      }),
    ).toBeUndefined();
  });

  it("exposes the billing interval used by analytics dimensions", () => {
    expect(
      priceBillingInterval(price({ amountCents: 2500, interval: "month" })),
    ).toBe("month");
  });
});
