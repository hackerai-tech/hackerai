import type Stripe from "stripe";
import {
  invoiceSubscriptionId,
  stripeObjectId,
} from "./subscription-payment-failure";

/** Search is discovery only; support decisions use the refreshed invoice. */
export async function* listLatePaymentReviews(
  stripe: Stripe,
  livemode: boolean,
): AsyncGenerator<Stripe.Invoice> {
  const seen = new Set<string>();
  for await (const result of stripe.invoices.search({
    query: "metadata['hackeraiLatePaymentReview']:'required'",
    limit: 100,
  })) {
    if (seen.has(result.id)) continue;
    seen.add(result.id);
    const invoice = await stripe.invoices.retrieve(result.id);
    if (invoice.livemode !== livemode) {
      throw new Error("Late payment review environment mismatch");
    }
    if (
      invoice.status === "paid" &&
      invoice.amount_paid > 0 &&
      invoice.metadata?.hackeraiLatePaymentReview === "required" &&
      !invoice.metadata.hackeraiLatePaymentResolution
    ) {
      yield invoice;
    }
  }
}

/** Persist an invoice-linked support case before acknowledging its webhook. */
export async function requireLatePaymentReview(
  stripe: Stripe,
  snapshot: Stripe.Invoice,
  reason: string,
): Promise<void> {
  if (snapshot.status !== "paid" || snapshot.amount_paid <= 0) return;
  const subscriptionId = invoiceSubscriptionId(snapshot);
  const customerId = stripeObjectId(snapshot.customer);
  if (!subscriptionId || !customerId) return;

  const invoice = await stripe.invoices.retrieve(snapshot.id);
  if (
    invoice.id !== snapshot.id ||
    invoiceSubscriptionId(invoice) !== subscriptionId ||
    stripeObjectId(invoice.customer) !== customerId ||
    invoice.livemode !== snapshot.livemode ||
    invoice.currency !== snapshot.currency ||
    invoice.status !== "paid" ||
    invoice.amount_paid !== snapshot.amount_paid
  ) {
    throw new Error(`Late payment review invoice changed: ${snapshot.id}`);
  }

  // Support's resolution is authoritative. Never clear it or reopen a resolved
  // case on a delayed delivery. A concurrent resolution is preserved because
  // Stripe merges only the supplied metadata keys.
  if (invoice.metadata?.hackeraiLatePaymentResolution) return;
  if (invoice.metadata?.hackeraiLatePaymentReview === "required") return;
  await stripe.invoices.update(invoice.id, {
    metadata: {
      hackeraiLatePaymentReview: "required",
      hackeraiLatePaymentReviewReason: reason,
      hackeraiLatePaymentReviewOwner: "billing-support",
    },
  });
}
