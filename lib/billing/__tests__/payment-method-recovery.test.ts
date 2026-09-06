import Stripe from "stripe";
import { recoverSubscriptionPayment } from "../payment-method-recovery";

function fixture() {
  const update = jest.fn().mockResolvedValue({});
  const pay = jest.fn().mockResolvedValue({ status: "paid" });
  const stripe = {
    subscriptions: { update },
    invoices: { pay },
  } as unknown as Stripe;
  const subscription = {
    id: "sub_recovery",
    customer: "cus_recovery",
    status: "past_due",
    collection_method: "charge_automatically",
    default_payment_method: "pm_old",
    latest_invoice: "in_recovery",
  } as Stripe.Subscription;
  const invoice = {
    id: "in_recovery",
    customer: "cus_recovery",
    status: "open",
    collection_method: "charge_automatically",
    billing_reason: "subscription_cycle",
    amount_remaining: 2000,
    parent: { subscription_details: { subscription: "sub_recovery" } },
  } as Stripe.Invoice;
  return {
    stripe,
    subscription,
    invoice,
    paymentMethodId: "pm_new",
    update,
    pay,
  };
}

describe("payment method recovery", () => {
  it("replaces the subscription override before paying the renewal with the selected card", async () => {
    const f = fixture();
    expect(await recoverSubscriptionPayment(f)).toBe("paid");
    expect(f.update).toHaveBeenCalledWith(
      "sub_recovery",
      { default_payment_method: "pm_new" },
      { idempotencyKey: "recovery-card:sub_recovery:pm_new" },
    );
    expect(f.pay).toHaveBeenCalledWith(
      "in_recovery",
      { payment_method: "pm_new" },
      { idempotencyKey: "recovery-payment:in_recovery:pm_new" },
    );
    expect(f.update.mock.invocationCallOrder[0]).toBeLessThan(
      f.pay.mock.invocationCallOrder[0],
    );
  });

  it("uses the same payment idempotency key across webhook deliveries", async () => {
    const f = fixture();
    await recoverSubscriptionPayment(f);
    f.subscription.default_payment_method = "pm_new";
    await recoverSubscriptionPayment(f);
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.pay.mock.calls[0]).toEqual(f.pay.mock.calls[1]);
  });

  it.each([
    ["canceled", { status: "canceled" }],
    ["already active", { status: "active" }],
    ["scheduled cancellation", { cancel_at_period_end: true }],
    ["custom cancellation", { cancel_at: 2000000000 }],
    ["paused collection", { pause_collection: { behavior: "void" } }],
    ["manual collection", { collection_method: "send_invoice" }],
    ["stale invoice", { latest_invoice: "in_newer" }],
    ["different customer", { customer: "cus_other" }],
  ])("does not charge a %s subscription", async (_label, override) => {
    const f = fixture();
    Object.assign(f.subscription, override);
    expect(await recoverSubscriptionPayment(f)).toBe("skipped");
    expect(f.update).not.toHaveBeenCalled();
    expect(f.pay).not.toHaveBeenCalled();
  });

  it.each([
    ["paid", { status: "paid" }],
    ["void", { status: "void" }],
    ["written off", { status: "uncollectible" }],
    ["zero balance", { amount_remaining: 0 }],
    ["upgrade", { billing_reason: "subscription_update" }],
    ["first payment", { billing_reason: "subscription_create" }],
    ["manual collection", { collection_method: "send_invoice" }],
    [
      "different subscription",
      { parent: { subscription_details: { subscription: "sub_other" } } },
    ],
  ])("does not charge a %s invoice", async (_label, override) => {
    const f = fixture();
    Object.assign(f.invoice, override);
    expect(await recoverSubscriptionPayment(f)).toBe("skipped");
    expect(f.pay).not.toHaveBeenCalled();
  });

  it.each(["processing", "succeeded", "requires_capture"] as const)(
    "does not interfere with a %s payment",
    async (status) => {
      const f = fixture();
      expect(
        await recoverSubscriptionPayment({
          ...f,
          paymentIntent: { status } as Stripe.PaymentIntent,
        }),
      ).toBe("skipped");
      expect(f.pay).not.toHaveBeenCalled();
    },
  );

  it("keeps the account pending if the new card requires authentication", async () => {
    const f = fixture();
    f.pay.mockRejectedValue(
      new Stripe.errors.StripeCardError({
        message: "Authentication required",
        code: "authentication_required",
      }),
    );
    expect(await recoverSubscriptionPayment(f)).toBe("pending");
  });

  it("tolerates Stripe collecting the invoice concurrently", async () => {
    const f = fixture();
    f.pay.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        message: "Invoice is already paid",
        code: "invoice_already_paid",
      }),
    );
    expect(await recoverSubscriptionPayment(f)).toBe("paid");
  });

  it("retries delivery after a Stripe outage instead of losing recovery", async () => {
    const f = fixture();
    f.pay.mockRejectedValue(new Error("Stripe unavailable"));
    await expect(recoverSubscriptionPayment(f)).rejects.toThrow(
      "Stripe unavailable",
    );
  });

  it("never pays if replacing the stale default fails", async () => {
    const f = fixture();
    f.update.mockRejectedValue(new Error("Update failed"));
    await expect(recoverSubscriptionPayment(f)).rejects.toThrow(
      "Update failed",
    );
    expect(f.pay).not.toHaveBeenCalled();
  });
});
