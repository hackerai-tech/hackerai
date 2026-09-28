import { describe, expect, it, jest } from "@jest/globals";
import type Stripe from "stripe";
import {
  hasRecentCanceledRenewalAtRisk,
  voidOpenCanceledRenewalInvoice,
} from "../canceled-renewal-invoice";

const endedAt = 1_790_236_981;
const subscription = {
  id: "sub_old",
  status: "canceled",
  ended_at: endedAt,
  customer: "cus_123",
  latest_invoice: "in_old",
  cancellation_details: { reason: "cancellation_requested" },
} as Stripe.Subscription;

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "in_old",
    customer: "cus_123",
    parent: { subscription_details: { subscription: "sub_old" } },
    billing_reason: "subscription_cycle",
    collection_method: "charge_automatically",
    status: "open",
    amount_remaining: 6000,
    amount_paid: 0,
    lines: {
      has_more: false,
      data: [
        {
          parent: {
            type: "subscription_item_details",
            subscription_item_details: {
              subscription: "sub_old",
              proration: false,
            },
          },
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Invoice;
}

function stripeMock(currentInvoice: Stripe.Invoice) {
  const voidInvoice = jest.fn();
  const listInvoicePayments = jest
    .fn()
    .mockResolvedValue({ data: [] } as never);
  const retrieveIntent = jest.fn();
  const retrieveCharge = jest.fn();
  const listRefunds = jest.fn();
  return {
    stripe: {
      invoices: {
        retrieve: jest.fn().mockResolvedValue(currentInvoice as never),
        voidInvoice,
      },
      subscriptions: {
        list: jest.fn().mockResolvedValue({ data: [subscription] } as never),
      },
      invoicePayments: { list: listInvoicePayments },
      paymentIntents: { retrieve: retrieveIntent },
      charges: { retrieve: retrieveCharge },
      refunds: { list: listRefunds },
    } as unknown as Stripe,
    voidInvoice,
    listInvoicePayments,
    retrieveIntent,
    retrieveCharge,
    listRefunds,
  };
}

describe("canceled renewal invoice", () => {
  it("does not void a renewal that also contains a separate invoice item", async () => {
    const mixedInvoice = invoice({
      lines: {
        has_more: false,
        data: [{ parent: { type: "invoice_item_details" } }],
      },
    });
    const { stripe, voidInvoice } = stripeMock(mixedInvoice);

    await expect(
      voidOpenCanceledRenewalInvoice(stripe, subscription),
    ).resolves.toBe("not_applicable");
    expect(voidInvoice).not.toHaveBeenCalled();
  });

  it("blocks checkout while a recent canceled renewal remains open", async () => {
    const { stripe } = stripeMock(invoice());

    await expect(
      hasRecentCanceledRenewalAtRisk(stripe, "cus_123", endedAt + 120),
    ).resolves.toBe(true);
  });

  it("keeps a collectible invoice blocked even with a support note", async () => {
    for (const status of ["open", "uncollectible"]) {
      const { stripe } = stripeMock(
        invoice({
          status,
          metadata: { hackeraiLatePaymentResolution: "reviewed" },
        }),
      );
      await expect(
        hasRecentCanceledRenewalAtRisk(stripe, "cus_123", endedAt + 120),
      ).resolves.toBe(true);
    }
  });

  it("does not block checkout after the renewal has been voided", async () => {
    const { stripe } = stripeMock(invoice({ status: "void" }));

    await expect(
      hasRecentCanceledRenewalAtRisk(stripe, "cus_123", endedAt + 120),
    ).resolves.toBe(false);
  });

  it("allows checkout after support marked a paid renewal resolved", async () => {
    const { stripe, listInvoicePayments } = stripeMock(
      invoice({
        status: "paid",
        status_transitions: { paid_at: endedAt + 120 },
        metadata: { hackeraiLatePaymentResolution: "replacement_month" },
      }),
    );

    await expect(
      hasRecentCanceledRenewalAtRisk(stripe, "cus_123", endedAt + 180),
    ).resolves.toBe(false);
    expect(listInvoicePayments).not.toHaveBeenCalled();
  });

  it("allows checkout only after the entire paid renewal charge is refunded", async () => {
    const paidInvoice = invoice({
      status: "paid",
      amount_paid: 6000,
      amount_remaining: 0,
      currency: "usd",
      status_transitions: { paid_at: endedAt + 120 },
    });
    const {
      stripe,
      listInvoicePayments,
      retrieveIntent,
      retrieveCharge,
      listRefunds,
    } = stripeMock(paidInvoice);
    listInvoicePayments.mockResolvedValue({
      data: [
        {
          invoice: "in_old",
          amount_paid: 6000,
          payment: { type: "payment_intent", payment_intent: "pi_old" },
        },
      ],
    } as never);
    retrieveIntent.mockResolvedValue({
      status: "succeeded",
      latest_charge: "ch_old",
    } as never);
    retrieveCharge.mockResolvedValue({
      amount: 6000,
      amount_refunded: 6000,
      currency: "usd",
      customer: "cus_123",
    } as never);
    listRefunds.mockResolvedValue({
      data: [{ status: "succeeded", amount: 6000 }],
    } as never);

    await expect(
      hasRecentCanceledRenewalAtRisk(stripe, "cus_123", endedAt + 180),
    ).resolves.toBe(false);

    listRefunds.mockResolvedValue({
      data: [{ status: "pending", amount: 6000 }],
    } as never);
    await expect(
      hasRecentCanceledRenewalAtRisk(stripe, "cus_123", endedAt + 180),
    ).resolves.toBe(true);
  });
});
