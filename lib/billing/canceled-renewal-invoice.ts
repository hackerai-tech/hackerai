import type Stripe from "stripe";
import {
  invoiceSubscriptionId,
  stripeObjectId,
} from "./subscription-payment-failure";

// A checkout shortly after an immediate cancellation can race a late payment
// against the old renewal invoice. Keep the review window bounded so an old
// canceled subscription does not prevent an unrelated future signup.
const RECENT_CANCELLATION_SECONDS = 30 * 24 * 60 * 60;
const PAYMENT_CANCELLATION_RACE_SECONDS = 60 * 60;

export async function getCanceledRenewalInvoice(
  stripe: Stripe,
  subscription: Stripe.Subscription,
): Promise<Stripe.Invoice | undefined> {
  const invoiceId = stripeObjectId(subscription.latest_invoice);
  const customerId = stripeObjectId(subscription.customer);
  if (
    subscription.status !== "canceled" ||
    !["cancellation_requested", "payment_failed"].includes(
      subscription.cancellation_details?.reason ?? "",
    ) ||
    !invoiceId ||
    !customerId
  ) {
    return undefined;
  }

  const invoice = await stripe.invoices.retrieve(invoiceId);
  if (
    stripeObjectId(invoice.customer) !== customerId ||
    invoiceSubscriptionId(invoice) !== subscription.id ||
    invoice.billing_reason !== "subscription_cycle" ||
    invoice.collection_method !== "charge_automatically"
  ) {
    return undefined;
  }

  return invoice;
}

export async function voidOpenCanceledRenewalInvoice(
  stripe: Stripe,
  subscription: Stripe.Subscription,
): Promise<"voided" | "paid" | "not_applicable"> {
  if (subscription.cancellation_details?.reason !== "cancellation_requested") {
    return "not_applicable";
  }
  const invoice = await getCanceledRenewalInvoice(stripe, subscription);
  if (!invoice) return "not_applicable";
  if (invoice.status === "paid") return "paid";
  if (
    invoice.status !== "open" ||
    invoice.amount_remaining <= 0 ||
    invoice.amount_paid !== 0 ||
    invoice.lines?.has_more ||
    !invoice.lines?.data.length ||
    invoice.lines.data.some(
      (line) =>
        line.parent?.type !== "subscription_item_details" ||
        line.parent.subscription_item_details?.subscription !==
          subscription.id ||
        line.parent.subscription_item_details?.proration !== false,
    )
  ) {
    return "not_applicable";
  }

  await stripe.invoices.voidInvoice(invoice.id);
  return "voided";
}

async function hasFullyRefundedInvoicePayment(
  stripe: Stripe,
  invoice: Stripe.Invoice,
): Promise<boolean> {
  const payments = await stripe.invoicePayments.list({
    invoice: invoice.id,
    status: "paid",
    limit: 2,
  });
  const payment = payments.data[0];
  if (
    payments.has_more ||
    payments.data.length !== 1 ||
    !payment ||
    stripeObjectId(payment.invoice) !== invoice.id ||
    payment.amount_paid !== invoice.amount_paid ||
    payment.payment.type !== "payment_intent"
  ) {
    return false;
  }

  const intentId = stripeObjectId(payment.payment.payment_intent);
  if (!intentId) return false;
  const intent = await stripe.paymentIntents.retrieve(intentId);
  const chargeId = stripeObjectId(intent.latest_charge);
  if (!chargeId || intent.status !== "succeeded") return false;
  const charge = await stripe.charges.retrieve(chargeId);
  if (
    charge.amount !== invoice.amount_paid ||
    charge.amount_refunded !== charge.amount ||
    charge.currency !== invoice.currency ||
    stripeObjectId(charge.customer) !== stripeObjectId(invoice.customer)
  ) {
    return false;
  }

  const refunds = await stripe.refunds.list({ charge: chargeId, limit: 100 });
  return (
    !refunds.has_more &&
    refunds.data.length > 0 &&
    refunds.data.every((refund) => refund.status === "succeeded") &&
    refunds.data.reduce((amount, refund) => amount + refund.amount, 0) ===
      charge.amount
  );
}

export async function hasRecentCanceledRenewalAtRisk(
  stripe: Stripe,
  customerId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  let startingAfter: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "canceled",
      limit: 100,
      ...(startingAfter && { starting_after: startingAfter }),
    });

    for (const subscription of subscriptions.data) {
      const endedAt = subscription.ended_at;
      if (
        !endedAt ||
        endedAt > nowSeconds ||
        nowSeconds - endedAt > RECENT_CANCELLATION_SECONDS
      ) {
        continue;
      }

      const invoice = await getCanceledRenewalInvoice(stripe, subscription);
      if (!invoice) continue;
      if (invoice.status === "open" && invoice.amount_remaining > 0) {
        return true;
      }
      if (invoice.status === "paid") {
        if (
          (invoice.status_transitions.paid_at ?? 0) <
          endedAt - PAYMENT_CANCELLATION_RACE_SECONDS
        ) {
          continue;
        }
        if (invoice.metadata?.hackeraiLatePaymentResolution) continue;
        if (await hasFullyRefundedInvoicePayment(stripe, invoice)) continue;
        return true;
      }
    }

    if (!subscriptions.has_more) return false;
    startingAfter = subscriptions.data.at(-1)?.id;
    if (!startingAfter) return true;
  }

  // Stripe history was too large to inspect completely. Stop checkout rather
  // than silently skipping an unresolved payment.
  return true;
}
