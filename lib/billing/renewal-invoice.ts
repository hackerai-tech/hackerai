import type Stripe from "stripe";
import {
  invoiceSubscriptionId,
  stripeObjectId,
} from "./subscription-payment-failure";

/** Collection is only valid for the current, uncanceled automatic renewal. */
export function isPayableRenewalInvoice(
  subscription: Stripe.Subscription,
  invoice: Stripe.Invoice,
  customerId: string,
): boolean {
  return (
    ["past_due", "unpaid"].includes(subscription.status) &&
    stripeObjectId(subscription.customer) === customerId &&
    stripeObjectId(invoice.customer) === customerId &&
    invoiceSubscriptionId(invoice) === subscription.id &&
    stripeObjectId(subscription.latest_invoice) === invoice.id &&
    subscription.collection_method === "charge_automatically" &&
    !subscription.cancel_at_period_end &&
    !subscription.cancel_at &&
    !subscription.pause_collection &&
    invoice.status === "open" &&
    invoice.collection_method === "charge_automatically" &&
    invoice.billing_reason === "subscription_cycle" &&
    invoice.amount_remaining > 0
  );
}
