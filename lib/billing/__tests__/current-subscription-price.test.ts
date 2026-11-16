import { describe, expect, it, jest } from "@jest/globals";
import type Stripe from "stripe";

jest.mock("@/app/api/stripe", () => ({ stripe: {} }));

import {
  subscriptionPlanFromPrice,
  subscriptionTierFromPrice,
  toCurrentSubscriptionContext,
} from "../current-subscription";
import { GRANDFATHERED_PRO_MONTHLY_PRICE_ID } from "@/lib/pricing/pro-monthly";
import { GRANDFATHERED_PRO_YEARLY_PRICE_ID } from "@/lib/pricing/pro-yearly";

describe("grandfathered Pro monthly Price", () => {
  const price = {
    id: GRANDFATHERED_PRO_MONTHLY_PRICE_ID,
    lookup_key: null,
    unit_amount: 2500,
    currency: "usd",
    recurring: { interval: "month", interval_count: 1 },
  } as Stripe.Price;

  it("keeps existing $25 subscribers on Pro without a lookup key", () => {
    expect(subscriptionPlanFromPrice(price)).toBe("pro-monthly-plan");
    expect(subscriptionTierFromPrice(price)).toBe("pro");
    const context = toCurrentSubscriptionContext({
      id: "sub_old",
      status: "active",
      cancel_at_period_end: false,
      metadata: {},
      items: { data: [{ id: "si_old", price, quantity: 1 }] },
    } as Stripe.Subscription);
    expect(context).toMatchObject({
      plan: "pro-monthly-plan",
      tier: "pro",
      priceId: GRANDFATHERED_PRO_MONTHLY_PRICE_ID,
      unitAmountDollars: 25,
    });
  });

  it("does not classify an unrelated Price without a lookup key", () => {
    expect(
      subscriptionTierFromPrice({ ...price, id: "price_other" }),
    ).toBeUndefined();
  });
});

it("preserves the existing $252 annual plan after its lookup key is transferred", () => {
  const price = {
    id: GRANDFATHERED_PRO_YEARLY_PRICE_ID,
    lookup_key: null,
    unit_amount: 25200,
    currency: "usd",
    recurring: { interval: "year", interval_count: 1 },
  } as Stripe.Price;
  expect(subscriptionPlanFromPrice(price)).toBe("pro-yearly-plan");
  expect(subscriptionTierFromPrice(price)).toBe("pro");
  expect(
    toCurrentSubscriptionContext({
      id: "sub_existing_yearly",
      status: "active",
      cancel_at_period_end: false,
      metadata: {},
      items: { data: [{ id: "si_existing", price, quantity: 1 }] },
    } as Stripe.Subscription),
  ).toMatchObject({
    plan: "pro-yearly-plan",
    tier: "pro",
    unitAmountDollars: 252,
    billingInterval: "year",
    priceId: GRANDFATHERED_PRO_YEARLY_PRICE_ID,
  });
});
