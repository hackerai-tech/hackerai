import Stripe from "stripe";
import {
  invoiceSubscriptionId,
  stripeObjectId,
} from "./subscription-payment-failure";

/** Recover only the latest automatic renewal after an explicit default-card change. */
export async function recoverSubscriptionPayment({
  stripe,
  subscription,
  invoice,
  paymentMethodId,
  paymentIntent,
}: {
  stripe: Stripe;
  subscription: Stripe.Subscription;
  invoice: Stripe.Invoice;
  paymentMethodId: string;
  paymentIntent?: Stripe.PaymentIntent | null;
}): Promise<"skipped" | "paid" | "pending"> {
  if (
    !["past_due", "unpaid"].includes(subscription.status) ||
    subscription.collection_method !== "charge_automatically" ||
    subscription.cancel_at_period_end ||
    subscription.cancel_at ||
    subscription.pause_collection ||
    stripeObjectId(subscription.latest_invoice) !== invoice.id ||
    invoiceSubscriptionId(invoice) !== subscription.id ||
    stripeObjectId(invoice.customer) !==
      stripeObjectId(subscription.customer) ||
    invoice.status !== "open" ||
    invoice.collection_method !== "charge_automatically" ||
    invoice.billing_reason !== "subscription_cycle" ||
    invoice.amount_remaining <= 0 ||
    (paymentIntent &&
      ["processing", "succeeded", "requires_capture"].includes(
        paymentIntent.status,
      ))
  ) {
    return "skipped";
  }

  // A subscription-level default wins over the customer's new default. Keep
  // future renewals on the newly selected card as well as paying this invoice.
  if (stripeObjectId(subscription.default_payment_method) !== paymentMethodId) {
    await stripe.subscriptions.update(
      subscription.id,
      { default_payment_method: paymentMethodId },
      { idempotencyKey: `recovery-card:${subscription.id}:${paymentMethodId}` },
    );
  }

  try {
    const paid = await stripe.invoices.pay(
      invoice.id,
      { payment_method: paymentMethodId },
      // Customer/subscription webhooks and retries must share the same key.
      { idempotencyKey: `recovery-payment:${invoice.id}:${paymentMethodId}` },
    );
    // Entitlements are restored exclusively by the existing invoice.paid path.
    return paid.status === "paid" ? "paid" : "pending";
  } catch (error) {
    // A replacement card can still decline or require customer authentication.
    // Acknowledge those outcomes; retry delivery only for operational failures.
    if (error instanceof Stripe.errors.StripeCardError) return "pending";
    if (
      error instanceof Stripe.errors.StripeInvalidRequestError &&
      error.code === "invoice_already_paid"
    ) {
      return "paid";
    }
    throw error;
  }
}
