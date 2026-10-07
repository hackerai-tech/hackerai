"use server";

import { stripe } from "@/app/api/stripe";
import { getBillingActionContext } from "@/lib/actions/billing-context";
import { CURRENT_SUBSCRIPTION_STATUSES } from "@/lib/billing/current-subscription";
import { isPayableRenewalInvoice } from "@/lib/billing/renewal-invoice";
import { stripeObjectId } from "@/lib/billing/subscription-payment-failure";
import { assertUserCanStartBillingTransaction } from "@/lib/suspensions";

/** Returns a fresh Stripe-hosted URL. Never charges or accepts a client invoice ID. */
export default async function openRenewalInvoice(): Promise<string> {
  const context = await getBillingActionContext();
  await assertUserCanStartBillingTransaction(context.user.id);
  const subscriptions = await stripe.subscriptions.list({
    customer: context.stripeCustomerId,
    status: "all",
    limit: 10,
  });
  const current = subscriptions.data.filter((s) =>
    CURRENT_SUBSCRIPTION_STATUSES.has(s.status),
  );
  if (subscriptions.has_more || current.length !== 1) {
    throw new Error(
      "No payable renewal invoice found. Check your billing status.",
    );
  }
  const subscription = current[0];
  const invoiceId = stripeObjectId(subscription.latest_invoice);
  if (!invoiceId)
    throw new Error(
      "No payable renewal invoice found. Check your billing status.",
    );
  const invoice = await stripe.invoices.retrieve(invoiceId);
  if (
    !isPayableRenewalInvoice(subscription, invoice, context.stripeCustomerId)
  ) {
    throw new Error(
      "No payable renewal invoice found. Check your billing status.",
    );
  }
  const url = invoice.hosted_invoice_url;
  if (!url)
    throw new Error(
      "Invoice payment page is unavailable. Open billing to review it.",
    );
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "invoice.stripe.com"
  ) {
    throw new Error(
      "Invoice payment page is unavailable. Open billing to review it.",
    );
  }
  return url;
}
