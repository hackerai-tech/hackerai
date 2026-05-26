import { describe, expect, it } from "@jest/globals";
import { getInvoicePaidBucketResetMode } from "../subscription-invoice-reset";

describe("getInvoicePaidBucketResetMode", () => {
  it("allows full resets for paid renewal invoices", () => {
    expect(
      getInvoicePaidBucketResetMode({
        billing_reason: "subscription_cycle",
        amount_paid: 4000,
      }),
    ).toEqual({
      mode: "full_reset",
      reason: "subscription_cycle",
    });
  });

  it("allows full resets for paid subscription creation invoices", () => {
    expect(
      getInvoicePaidBucketResetMode({
        billing_reason: "subscription_create",
        amount_paid: 2500,
      }),
    ).toEqual({
      mode: "full_reset",
      reason: "subscription_create",
    });
  });

  it("routes subscription updates only through the proration path", () => {
    expect(
      getInvoicePaidBucketResetMode({
        billing_reason: "subscription_update",
        amount_paid: 100,
      }),
    ).toEqual({
      mode: "subscription_update_proration",
      reason: "subscription_update",
    });
  });

  it("skips manual and threshold invoices", () => {
    expect(
      getInvoicePaidBucketResetMode({
        billing_reason: "manual",
        amount_paid: 4000,
      }),
    ).toEqual({
      mode: "skip",
      reason: "manual",
    });

    expect(
      getInvoicePaidBucketResetMode({
        billing_reason: "subscription_threshold",
        amount_paid: 4000,
      }),
    ).toEqual({
      mode: "skip",
      reason: "subscription_threshold",
    });
  });

  it("skips zero-dollar and credit-paid renewal invoices", () => {
    expect(
      getInvoicePaidBucketResetMode({
        billing_reason: "subscription_cycle",
        amount_paid: 0,
      }),
    ).toEqual({
      mode: "skip",
      reason: "subscription_cycle:non_positive_amount",
    });
  });
});
