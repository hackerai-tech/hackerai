import type Stripe from "stripe";
import { reconcileLateSubscriptionPayment } from "../late-subscription-payment";

const endedAt = 1_788_889_078;
const paidAt = endedAt + 2050;

function fixture() {
  const subscription = {
    id: "sub_ended",
    customer: "cus_test",
    status: "canceled",
    currency: "usd",
    livemode: false,
    ended_at: endedAt,
    latest_invoice: "in_late",
    cancellation_details: { reason: "payment_failed" },
  } as Stripe.Subscription;
  const invoice = {
    id: "in_late",
    customer: "cus_test",
    status: "paid",
    billing_reason: "subscription_cycle",
    collection_method: "charge_automatically",
    amount_paid: 2500,
    currency: "usd",
    livemode: false,
    metadata: {},
    status_transitions: { paid_at: paidAt },
    parent: { subscription_details: { subscription: subscription.id } },
  } as Stripe.Invoice;
  const payment = {
    id: "inpay_late",
    invoice: invoice.id,
    amount_paid: 2500,
    currency: "usd",
    status_transitions: { paid_at: paidAt },
    payment: { type: "payment_intent", payment_intent: "pi_late" },
  } as Stripe.InvoicePayment;
  const charge = {
    id: "ch_late",
    customer: "cus_test",
    paid: true,
    captured: true,
    disputed: false,
    amount: 2500,
    amount_captured: 2500,
    amount_refunded: 0,
    currency: "usd",
    livemode: false,
  } as Stripe.Charge;
  const refund = {
    id: "re_late",
    status: "succeeded",
    metadata: {
      hackeraiReason: "subscription_payment_after_cancellation",
      stripeInvoiceId: invoice.id,
    },
  } as Stripe.Refund;
  const retrieveInvoice = jest.fn().mockResolvedValue(invoice);
  const listSubscriptions = jest.fn().mockReturnValue([subscription]);
  const listPayments = jest
    .fn()
    .mockResolvedValue({ data: [payment], has_more: false });
  const retrieveIntent = jest
    .fn()
    .mockResolvedValue({ status: "succeeded", latest_charge: charge.id });
  const retrieveCharge = jest.fn().mockResolvedValue(charge);
  const listRefunds = jest.fn().mockReturnValue([]);
  const createRefund = jest.fn().mockResolvedValue(refund);
  const stripe = {
    invoices: { retrieve: retrieveInvoice },
    subscriptions: { list: listSubscriptions },
    invoicePayments: { list: listPayments },
    paymentIntents: { retrieve: retrieveIntent },
    charges: { retrieve: retrieveCharge },
    refunds: { list: listRefunds, create: createRefund },
  } as unknown as Stripe;
  const run = () =>
    reconcileLateSubscriptionPayment(stripe, invoice, subscription);
  return {
    run,
    stripe,
    invoice,
    subscription,
    payment,
    charge,
    refund,
    retrieveInvoice,
    listSubscriptions,
    listPayments,
    retrieveIntent,
    retrieveCharge,
    listRefunds,
    createRefund,
  };
}

describe("late subscription payments", () => {
  it("refunds the exact renewal paid after automatic cancellation", async () => {
    const f = fixture();
    expect(await f.run()).toEqual({ status: "refunded", refundId: "re_late" });
    expect(f.createRefund).toHaveBeenCalledWith(
      {
        charge: "ch_late",
        amount: 2500,
        metadata: { ...f.refund.metadata, stripeSubscriptionId: "sub_ended" },
      },
      { idempotencyKey: "late-subscription-payment:in_late:ch_late" },
    );
  });

  it.each([endedAt - 1, endedAt])(
    "does not refund a payment made before or at cancellation (%s)",
    async (paid) => {
      const f = fixture();
      f.invoice.status_transitions.paid_at = paid;
      expect(await f.run()).toEqual({ status: "not_applicable" });
      expect(f.retrieveInvoice).not.toHaveBeenCalled();
    },
  );

  it.each(["cancellation_requested", "payment_disputed"] as const)(
    "does not refund %s cancellations",
    async (reason) => {
      const f = fixture();
      f.subscription.cancellation_details!.reason = reason;
      expect(await f.run()).toEqual({ status: "not_applicable" });
      expect(f.createRefund).not.toHaveBeenCalled();
    },
  );

  it.each(["active", "trialing", "past_due", "unpaid"] as const)(
    "does not interfere with %s subscriptions",
    async (status) => {
      const f = fixture();
      f.subscription.status = status;
      expect(await f.run()).toEqual({ status: "not_applicable" });
    },
  );

  it.each(["subscription_create", "subscription_update", "manual"] as const)(
    "excludes %s invoices",
    async (reason) => {
      const f = fixture();
      f.invoice.billing_reason = reason;
      expect(await f.run()).toEqual({ status: "not_applicable" });
    },
  );

  it("ignores historical invoices and zero-dollar settlements", async () => {
    const f = fixture();
    f.subscription.latest_invoice = "in_newer";
    expect(await f.run()).toEqual({ status: "not_applicable" });
    f.subscription.latest_invoice = f.invoice.id;
    f.invoice.amount_paid = 0;
    expect(await f.run()).toEqual({ status: "not_applicable" });
  });

  it("honors a support resolution recorded after the webhook snapshot", async () => {
    const f = fixture();
    f.retrieveInvoice.mockResolvedValue({
      ...f.invoice,
      metadata: { hackeraiLatePaymentResolution: "replacement_subscription" },
    });
    expect(await f.run()).toMatchObject({ status: "manual_review" });
    expect(f.createRefund).not.toHaveBeenCalled();
  });

  it("does not refund a customer's manually replaced plan, even if it later ended", async () => {
    const f = fixture();
    f.listSubscriptions.mockReturnValue([
      f.subscription,
      { id: "sub_replacement", created: paidAt, status: "canceled" },
    ]);
    expect(await f.run()).toEqual({
      status: "manual_review",
      reason: "replacement_subscription_exists",
    });
    expect(f.createRefund).not.toHaveBeenCalled();
  });

  it("requires matching customer and environment on the refreshed invoice", async () => {
    const f = fixture();
    for (const override of [
      { customer: "cus_other" },
      { livemode: true },
      { currency: "eur" },
    ]) {
      f.retrieveInvoice.mockResolvedValue({ ...f.invoice, ...override });
      expect(await f.run()).toMatchObject({ status: "manual_review" });
    }
    expect(f.createRefund).not.toHaveBeenCalled();
  });

  it("leaves partial, multiple, external, and pre-cancellation payments for review", async () => {
    const f = fixture();
    for (const data of [
      [],
      [f.payment, f.payment],
      [{ ...f.payment, amount_paid: 1000 }],
      [{ ...f.payment, payment: { type: "payment_record" } }],
      [{ ...f.payment, status_transitions: { paid_at: endedAt - 1 } }],
    ]) {
      f.listPayments.mockResolvedValue({ data, has_more: false });
      expect(await f.run()).toMatchObject({ status: "manual_review" });
    }
    expect(f.createRefund).not.toHaveBeenCalled();
  });

  it("does not refund a charge larger than its invoice allocation or a disputed charge", async () => {
    const f = fixture();
    for (const override of [
      { amount: 5000 },
      { amount_captured: 1000 },
      { disputed: true },
      { customer: "cus_other" },
    ]) {
      f.retrieveCharge.mockResolvedValue({ ...f.charge, ...override });
      expect(await f.run()).toMatchObject({ status: "manual_review" });
    }
    expect(f.createRefund).not.toHaveBeenCalled();
  });

  it.each([
    "succeeded",
    "pending",
    "requires_action",
    "failed",
    "canceled",
  ] as const)(
    "reconciles an existing %s refund without another transfer",
    async (status) => {
      const f = fixture();
      f.listRefunds.mockReturnValue([{ ...f.refund, status }]);
      expect(await f.run()).toMatchObject({
        status:
          status === "succeeded"
            ? "refunded"
            : ["pending", "requires_action"].includes(status)
              ? "refund_pending"
              : "manual_review",
      });
      expect(f.createRefund).not.toHaveBeenCalled();
    },
  );

  it("recognizes a completed refund after the customer resubscribes or support adds a note", async () => {
    const f = fixture();
    f.listRefunds.mockReturnValue([f.refund]);
    f.listSubscriptions.mockReturnValue([
      f.subscription,
      { id: "sub_new", created: paidAt + 60, status: "active" },
    ]);
    f.retrieveInvoice.mockResolvedValue({
      ...f.invoice,
      metadata: { hackeraiLatePaymentResolution: "refunded" },
    });
    expect(await f.run()).toEqual({
      status: "refunded",
      refundId: f.refund.id,
    });
    expect(f.createRefund).not.toHaveBeenCalled();
  });

  it("leaves a support refund unchanged", async () => {
    const f = fixture();
    f.listRefunds.mockReturnValue([
      { id: "re_support", metadata: {}, status: "pending" },
    ]);
    expect(await f.run()).toEqual({
      status: "manual_review",
      reason: "existing_refund",
    });
    expect(f.createRefund).not.toHaveBeenCalled();
  });

  it("does not report a pending refund as money returned", async () => {
    const f = fixture();
    f.createRefund.mockResolvedValue({ ...f.refund, status: "pending" });
    expect(await f.run()).toEqual({
      status: "refund_pending",
      refundId: "re_late",
    });
  });

  it("propagates uncertain failures and retries with identical refund parameters", async () => {
    const f = fixture();
    f.createRefund.mockRejectedValueOnce(new Error("connection lost"));
    await expect(f.run()).rejects.toThrow("connection lost");
    expect(await f.run()).toMatchObject({ status: "refunded" });
    expect(f.createRefund.mock.calls[0]).toEqual(f.createRefund.mock.calls[1]);
  });
});
