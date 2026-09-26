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
      if (
        invoice.status === "paid" &&
        (invoice.status_transitions.paid_at ?? 0) >=
          endedAt - PAYMENT_CANCELLATION_RACE_SECONDS
      ) {
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
