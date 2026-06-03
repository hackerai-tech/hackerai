import { describe, expect, it } from "@jest/globals";
import {
  priceBillingInterval,
  subscriptionMrrDollars,
} from "../subscription-mrr";

function price({
  amountCents,
  interval,
  intervalCount = 1,
}: {
  amountCents?: number;
  interval: "day" | "week" | "month" | "year";
  intervalCount?: number;
}) {
  return {
    unit_amount: amountCents,
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

  it("uses fallback amount only when the price amount is unavailable", () => {
    expect(
      subscriptionMrrDollars({
        price: price({ interval: "year" }),
        fallbackIntervalAmountDollars: 120,
      }),
    ).toBe(10);
  });

  it("returns undefined when the billing cadence is missing or invalid", () => {
    expect(
      subscriptionMrrDollars({
        price: undefined,
        fallbackIntervalAmountDollars: 120,
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

  it("exposes the billing interval used by analytics dimensions", () => {
    expect(
      priceBillingInterval(price({ amountCents: 2500, interval: "month" })),
    ).toBe("month");
  });
});
