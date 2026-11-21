import { describe, expect, it } from "@jest/globals";
import {
  getInvoicePaidBucketResetMode,
  replacedSubscriptionPeriodFromUpdateInvoice,
  type SubscriptionInvoiceLineFacts,
} from "../subscription-invoice-reset";

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

describe("replacedSubscriptionPeriodFromUpdateInvoice", () => {
  const day = 24 * 60 * 60;
  const prorationStart = 1_790_000_000;
  const monthlyEnd = prorationStart + 12 * day;
  // The current annual item's `current_period_end`.
  const annualEnd = prorationStart + 353 * day;
  const line = (
    overrides: Partial<SubscriptionInvoiceLineFacts>,
  ): SubscriptionInvoiceLineFacts => ({
    subscriptionId: "sub_1",
    proration: false,
    amount: 0,
    ...overrides,
  });
  // Observed shape: both lines are prorations from the same date; the annual
  // charge ends exactly at the current item's period end.
  const monthlyCredit = line({
    priceId: "price_monthly",
    proration: true,
    amount: -2_900,
    periodStartSeconds: prorationStart,
    periodEndSeconds: monthlyEnd,
  });
  const annualCharge = line({
    priceId: "price_yearly",
    proration: true,
    amount: 28_800,
    periodStartSeconds: prorationStart,
    periodEndSeconds: annualEnd,
  });
  const classify = (lines: SubscriptionInvoiceLineFacts[]) =>
    replacedSubscriptionPeriodFromUpdateInvoice({
      lines,
      subscriptionId: "sub_1",
      newPriceId: "price_yearly",
      newPeriodEndSeconds: annualEnd,
    });
  const replaced = {
    kind: "replaced",
    replacedPriceId: "price_monthly",
    replacedPeriodEndMs: monthlyEnd * 1000,
  };

  it("returns the credited monthly deadline for a dual-proration switch", () => {
    expect(classify([monthlyCredit, annualCharge])).toEqual(replaced);
  });

  it("returns the debited invoice only when every credit names the same one", () => {
    const credited = { ...monthlyCredit, creditedInvoiceId: "in_tier_change" };
    expect(classify([credited, credited, annualCharge])).toEqual({
      ...replaced,
      creditedInvoiceId: "in_tier_change",
    });
    // Disagreeing or partial provenance is not evidence for any invoice.
    expect(
      classify([
        credited,
        { ...credited, creditedInvoiceId: "in_other" },
        annualCharge,
      ]),
    ).toEqual(replaced);
    expect(classify([credited, monthlyCredit, annualCharge])).toEqual(replaced);
  });

  it("accepts a full annual period charged after a billing-anchor reset", () => {
    expect(
      classify([
        monthlyCredit,
        {
          ...annualCharge,
          proration: false,
          periodStartSeconds: prorationStart + 30,
        },
      ]),
    ).toEqual(replaced);
  });

  it("rejects a switch without the current item's period end", () => {
    expect(
      replacedSubscriptionPeriodFromUpdateInvoice({
        lines: [monthlyCredit, annualCharge],
        subscriptionId: "sub_1",
        newPriceId: "price_yearly",
        newPeriodEndSeconds: undefined,
      }),
    ).toEqual({
      kind: "not_applicable",
      reason: "new_period_end_mismatch",
    });
  });

  it.each([
    {
      name: "a credit and charge for the same Price",
      lines: [{ ...monthlyCredit, priceId: "price_yearly" }, annualCharge],
      reason: "replaced_price_ambiguous",
    },
    {
      name: "a charge ending before the current item's period end",
      lines: [
        monthlyCredit,
        { ...annualCharge, periodEndSeconds: annualEnd - day },
      ],
      reason: "new_period_end_mismatch",
    },
    {
      name: "a prorated charge from a different date than the credit",
      lines: [
        monthlyCredit,
        { ...annualCharge, periodStartSeconds: prorationStart + 60 },
      ],
      reason: "proration_start_mismatch",
    },
    {
      name: "a credited period ending with the new period",
      lines: [{ ...monthlyCredit, periodEndSeconds: annualEnd }, annualCharge],
      reason: "replaced_period_not_overlapping",
    },
    {
      name: "an unrelated extra subscription line",
      lines: [
        monthlyCredit,
        annualCharge,
        line({ priceId: "price_addon", proration: true, amount: 500 }),
      ],
      reason: "unexpected_subscription_lines",
    },
    {
      name: "a quantity or anchor update without a credited period",
      lines: [annualCharge],
      reason: "replaced_line_missing",
    },
    {
      name: "lines from another subscription",
      lines: [
        monthlyCredit,
        annualCharge,
        { ...monthlyCredit, subscriptionId: "sub_other" },
      ],
      reason: "other_subscription_lines",
    },
    {
      name: "an additional charge for the new Price",
      lines: [monthlyCredit, annualCharge, { ...annualCharge, amount: 500 }],
      reason: "new_period_line_not_unique",
    },
    {
      name: "credits for two different Prices",
      lines: [
        monthlyCredit,
        { ...monthlyCredit, priceId: "price_monthly_other" },
        annualCharge,
      ],
      reason: "replaced_price_ambiguous",
    },
    {
      name: "credits ending at different deadlines",
      lines: [
        monthlyCredit,
        { ...monthlyCredit, periodEndSeconds: monthlyEnd + 60 },
        annualCharge,
      ],
      reason: "replaced_period_ambiguous",
    },
    {
      name: "a credited period that ended before the new period",
      lines: [
        { ...monthlyCredit, periodEndSeconds: prorationStart - 60 },
        annualCharge,
      ],
      reason: "replaced_period_not_overlapping",
    },
  ])("rejects $name", ({ lines, reason }) => {
    expect(classify(lines)).toEqual({ kind: "not_applicable", reason });
  });
});
