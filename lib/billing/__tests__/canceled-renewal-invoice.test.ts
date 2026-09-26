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
  return {
    stripe: {
      invoices: {
        retrieve: jest.fn().mockResolvedValue(currentInvoice as never),
        voidInvoice,
      },
      subscriptions: {
        list: jest.fn().mockResolvedValue({ data: [subscription] } as never),
      },
    } as unknown as Stripe,
    voidInvoice,
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

  it("does not block checkout after the renewal has been voided", async () => {
    const { stripe } = stripeMock(invoice({ status: "void" }));

    await expect(
      hasRecentCanceledRenewalAtRisk(stripe, "cus_123", endedAt + 120),
    ).resolves.toBe(false);
  });
});
