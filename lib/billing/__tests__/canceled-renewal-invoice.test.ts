import { describe, expect, it, jest } from "@jest/globals";
import type Stripe from "stripe";
import {
  hasRecentCanceledRenewalAtRisk,
  voidUnpaidCanceledRenewalInvoice,
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

const automaticSubscription = {
  ...subscription,
  cancellation_details: { reason: "payment_failed" },
  items: {
    has_more: false,
    data: [
      {
        id: "si_old",
        quantity: 1,
        price: {
          id: "price_pro_plus",
          lookup_key: "pro-plus-monthly-plan",
          recurring: { usage_type: "licensed" },
        },
      },
    ],
  },
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
          quantity: 1,
          pricing: { price_details: { price: "price_pro_plus" } },
          parent: {
            type: "subscription_item_details",
            subscription_item_details: {
              subscription: "sub_old",
              subscription_item: "si_old",
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
  const voidInvoice = jest.fn().mockResolvedValue({ status: "void" } as never);
  const retrieveInvoice = jest.fn().mockResolvedValue(currentInvoice as never);
  const listInvoicePayments = jest
    .fn()
    .mockResolvedValue({ data: [] } as never);
  const retrieveIntent = jest.fn();
  const retrieveCharge = jest.fn();
  const listRefunds = jest.fn();
  return {
    stripe: {
      invoices: {
        retrieve: retrieveInvoice,
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
    retrieveInvoice,
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
      voidUnpaidCanceledRenewalInvoice(stripe, subscription),
    ).resolves.toBe("not_applicable");
    expect(voidInvoice).not.toHaveBeenCalled();
  });

  it.each(["open", "uncollectible"])(
    "voids an unpaid %s renewal after automatic cancellation and allows checkout",
    async (status) => {
      const { stripe, voidInvoice, retrieveInvoice } = stripeMock(
        invoice({ status }),
      );
      await expect(
        voidUnpaidCanceledRenewalInvoice(stripe, automaticSubscription),
      ).resolves.toBe("voided");
      expect(voidInvoice).toHaveBeenCalledWith("in_old");

      retrieveInvoice.mockResolvedValue(invoice({ status: "void" }) as never);
      await expect(
        hasRecentCanceledRenewalAtRisk(stripe, "cus_123", endedAt + 120),
      ).resolves.toBe(false);
      await expect(
        voidUnpaidCanceledRenewalInvoice(stripe, automaticSubscription),
      ).resolves.toBe("not_applicable");
      expect(voidInvoice).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { amount_paid: 1000 },
    { starting_balance: 1000 },
    { metadata: { hackeraiLatePaymentResolution: "reviewed" } },
    { pre_payment_credit_notes_amount: 1000 },
    { post_payment_credit_notes_amount: 1000 },
    { customer: "cus_other" },
    { billing_reason: "subscription_update" },
    { collection_method: "send_invoice" },
    { lines: { has_more: true, data: [] } },
    {
      lines: {
        has_more: false,
        data: [{ parent: { type: "invoice_item_details" } }],
      },
    },
    {
      lines: {
        has_more: false,
        data: [
          {
            parent: {
              type: "subscription_item_details",
              subscription_item_details: {
                subscription: "sub_old",
                proration: true,
              },
            },
          },
        ],
      },
    },
  ])("preserves an ambiguous or adjusted invoice: %j", async (overrides) => {
    const { stripe, voidInvoice } = stripeMock(invoice(overrides));
    await expect(
      voidUnpaidCanceledRenewalInvoice(stripe, automaticSubscription),
    ).resolves.toBe("not_applicable");
    expect(voidInvoice).not.toHaveBeenCalled();
  });

  it.each([
    "processing",
    "requires_action",
    "requires_confirmation",
    "succeeded",
  ])("does not void an invoice with a %s payment", async (status) => {
    const { stripe, voidInvoice, listInvoicePayments, retrieveIntent } =
      stripeMock(invoice());
    listInvoicePayments.mockResolvedValue({
      data: [
        {
          status: "open",
          payment: { type: "payment_intent", payment_intent: "pi_old" },
        },
      ],
      has_more: false,
    } as never);
    retrieveIntent.mockResolvedValue({ status } as never);
    await expect(
      voidUnpaidCanceledRenewalInvoice(stripe, automaticSubscription),
    ).resolves.toBe("not_applicable");
    expect(voidInvoice).not.toHaveBeenCalled();
  });

  it("voids a failed payment awaiting a new payment method", async () => {
    const { stripe, voidInvoice, listInvoicePayments, retrieveIntent } =
      stripeMock(invoice());
    listInvoicePayments.mockResolvedValue({
      data: [
        {
          status: "open",
          payment: { type: "payment_intent", payment_intent: "pi_old" },
        },
      ],
      has_more: false,
    } as never);
    retrieveIntent.mockResolvedValue({
      status: "requires_payment_method",
    } as never);
    await expect(
      voidUnpaidCanceledRenewalInvoice(stripe, automaticSubscription),
    ).resolves.toBe("voided");
    expect(voidInvoice).toHaveBeenCalledTimes(1);
  });

  it.each(["team-monthly-plan", "unknown-plan"])(
    "preserves %s renewals",
    async (lookupKey) => {
      const { stripe, voidInvoice } = stripeMock(invoice());
      const other = {
        ...automaticSubscription,
        items: {
          data: [
            {
              quantity: 1,
              price: {
                id: "price_other",
                lookup_key: lookupKey,
                recurring: { usage_type: "licensed" },
              },
            },
          ],
        },
      } as Stripe.Subscription;
      await expect(
        voidUnpaidCanceledRenewalInvoice(stripe, other),
      ).resolves.toBe("not_applicable");
      expect(voidInvoice).not.toHaveBeenCalled();
    },
  );

  it("preserves metered subscriptions", async () => {
    const { stripe, voidInvoice } = stripeMock(invoice());
    const other = {
      ...automaticSubscription,
      items: {
        data: [
          {
            ...automaticSubscription.items.data[0],
            price: {
              ...automaticSubscription.items.data[0].price,
              recurring: { usage_type: "metered" },
            },
          },
        ],
      },
    } as Stripe.Subscription;
    await expect(voidUnpaidCanceledRenewalInvoice(stripe, other)).resolves.toBe(
      "not_applicable",
    );
    expect(voidInvoice).not.toHaveBeenCalled();
  });

  it.each([
    { quantity: 2 },
    { quantity: null },
    {
      parent: {
        type: "subscription_item_details",
        subscription_item_details: {
          subscription: "sub_old",
          subscription_item: "si_other",
          proration: false,
        },
      },
    },
    { pricing: { price_details: { price: "price_other" } } },
  ])(
    "preserves a historical renewal that does not match the current item: %j",
    async (lineOverrides) => {
      const currentInvoice = invoice();
      const { stripe, voidInvoice } = stripeMock(
        invoice({
          lines: {
            has_more: false,
            data: [{ ...currentInvoice.lines.data[0], ...lineOverrides }],
          },
        }),
      );
      await expect(
        voidUnpaidCanceledRenewalInvoice(stripe, automaticSubscription),
      ).resolves.toBe("not_applicable");
      expect(voidInvoice).not.toHaveBeenCalled();
    },
  );

  it("preserves a renewal with multiple matching lines", async () => {
    const currentInvoice = invoice();
    const { stripe, voidInvoice } = stripeMock(
      invoice({
        lines: {
          has_more: false,
          data: [currentInvoice.lines.data[0], currentInvoice.lines.data[0]],
        },
      }),
    );
    await expect(
      voidUnpaidCanceledRenewalInvoice(stripe, automaticSubscription),
    ).resolves.toBe("not_applicable");
    expect(voidInvoice).not.toHaveBeenCalled();
  });

  it("rejects a resolved response that did not void the renewal", async () => {
    const { stripe, voidInvoice } = stripeMock(invoice());
    voidInvoice.mockResolvedValue({ status: "open" } as never);
    await expect(
      voidUnpaidCanceledRenewalInvoice(stripe, automaticSubscription),
    ).rejects.toThrow("Canceled renewal in_old was not voided");
  });

  it.each(["paid", "void"])(
    "accepts a concurrent %s transition",
    async (status) => {
      const { stripe, voidInvoice, retrieveInvoice } = stripeMock(invoice());
      voidInvoice.mockRejectedValue(
        new Error("Invoice state changed") as never,
      );
      retrieveInvoice
        .mockResolvedValueOnce(invoice() as never)
        .mockResolvedValueOnce(invoice({ status }) as never);
      await expect(
        voidUnpaidCanceledRenewalInvoice(stripe, automaticSubscription),
      ).resolves.toBe(status === "paid" ? "paid" : "voided");
    },
  );

  it("propagates operational errors so webhook delivery can retry", async () => {
    const { stripe, voidInvoice } = stripeMock(invoice());
    voidInvoice.mockRejectedValue(
      new Error("Invoice write permission missing") as never,
    );
    await expect(
      voidUnpaidCanceledRenewalInvoice(stripe, automaticSubscription),
    ).rejects.toThrow("Invoice write permission missing");
  });

  it("blocks checkout while a recent canceled renewal remains open", async () => {
    const { stripe } = stripeMock(invoice());

    await expect(
      hasRecentCanceledRenewalAtRisk(stripe, "cus_123", endedAt + 120),
    ).resolves.toBe(true);
  });

  it("preserves written-off renewals on manual cancellation and keeps checkout blocked", async () => {
    const { stripe, voidInvoice } = stripeMock(
      invoice({ status: "uncollectible" }),
    );
    await expect(
      voidUnpaidCanceledRenewalInvoice(stripe, subscription),
    ).resolves.toBe("not_applicable");
    expect(voidInvoice).not.toHaveBeenCalled();
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
