import type Stripe from "stripe";
import {
  invoiceSubscriptionId,
  stripeObjectId,
} from "./subscription-payment-failure";

type ReconciliationResult =
  | { status: "not_applicable" }
  | { status: "manual_review"; reason: string }
  | { status: "refunded" | "refund_pending"; refundId: string };

export const LATE_SUBSCRIPTION_PAYMENT_REFUND_REASON =
  "subscription_payment_after_cancellation";

/**
 * A late renewal payment cannot reactivate a canceled Stripe subscription.
 * Return an unambiguously unused payment instead of keeping money without
 * access. Ambiguous allocations and existing replacement plans need support.
 */
export async function reconcileLateSubscriptionPayment(
  stripe: Stripe,
  snapshot: Stripe.Invoice,
  subscription: Stripe.Subscription,
): Promise<ReconciliationResult> {
  const endedAt = subscription.ended_at;
  const paidAt = snapshot.status_transitions?.paid_at;
  if (
    subscription.status !== "canceled" ||
    subscription.cancellation_details?.reason !== "payment_failed" ||
    !endedAt ||
    !paidAt ||
    paidAt <= endedAt ||
    snapshot.status !== "paid" ||
    snapshot.billing_reason !== "subscription_cycle" ||
    snapshot.collection_method !== "charge_automatically" ||
    snapshot.amount_paid <= 0 ||
    invoiceSubscriptionId(snapshot) !== subscription.id ||
    stripeObjectId(subscription.latest_invoice) !== snapshot.id
  ) {
    return { status: "not_applicable" };
  }

  // Webhooks are snapshots. Honor subsequent support adjustments before money
  // moves, including a replacement month granted outside this handler.
  const invoice = await stripe.invoices.retrieve(snapshot.id);
  const customerId = stripeObjectId(subscription.customer);
  if (
    !customerId ||
    stripeObjectId(invoice.customer) !== customerId ||
    invoiceSubscriptionId(invoice) !== subscription.id ||
    invoice.status !== "paid" ||
    invoice.amount_paid !== snapshot.amount_paid ||
    invoice.status_transitions.paid_at !== paidAt ||
    invoice.currency !== subscription.currency ||
    invoice.livemode !== subscription.livemode
  ) {
    return { status: "manual_review", reason: "invoice_changed_or_reconciled" };
  }

  // Never refund an entire charge allocated across multiple invoices, or infer
  // a cash payment from amount_paid (which can include customer credit).
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
    payment.currency !== invoice.currency ||
    !payment.status_transitions.paid_at ||
    payment.status_transitions.paid_at <= endedAt ||
    payment.payment.type !== "payment_intent"
  ) {
    return { status: "manual_review", reason: "ambiguous_payment_allocation" };
  }
  const intentId = stripeObjectId(payment.payment.payment_intent);
  if (!intentId)
    return { status: "manual_review", reason: "missing_payment_intent" };
  const intent = await stripe.paymentIntents.retrieve(intentId);
  const chargeId = stripeObjectId(intent.latest_charge);
  if (!chargeId || intent.status !== "succeeded") {
    return { status: "manual_review", reason: "payment_not_settled" };
  }
  const charge = await stripe.charges.retrieve(chargeId);
  if (
    !charge.paid ||
    !charge.captured ||
    charge.disputed ||
    charge.amount !== invoice.amount_paid ||
    charge.amount_captured !== invoice.amount_paid ||
    charge.currency !== invoice.currency ||
    charge.livemode !== invoice.livemode ||
    stripeObjectId(charge.customer) !== customerId
  ) {
    return { status: "manual_review", reason: "charge_not_safely_refundable" };
  }

  // Stripe's idempotency cache expires. The durable refund itself protects
  // replays after that window and records pending/failed refunds explicitly.
  let managedRefund: Stripe.Refund | undefined;
  let otherRefundExists = false;
  for await (const refund of stripe.refunds.list({
    charge: chargeId,
    limit: 100,
  })) {
    if (
      refund.metadata?.hackeraiReason ===
        LATE_SUBSCRIPTION_PAYMENT_REFUND_REASON &&
      refund.metadata?.stripeInvoiceId === invoice.id
    ) {
      managedRefund ??= refund;
    } else {
      otherRefundExists = true;
    }
  }
  if (managedRefund) {
    if (managedRefund.status === "succeeded")
      return { status: "refunded", refundId: managedRefund.id };
    if (
      managedRefund.status === "pending" ||
      managedRefund.status === "requires_action"
    ) {
      return { status: "refund_pending", refundId: managedRefund.id };
    }
    return { status: "manual_review", reason: "refund_failed_or_canceled" };
  }
  // A support refund may be a partial settlement. Do not expand it to a full
  // refund or race another pending refund.
  if (otherRefundExists || charge.amount_refunded !== 0) {
    return { status: "manual_review", reason: "existing_refund" };
  }

  // Existing managed refunds above must remain recognizable on retries even
  // if support or the customer subsequently changes their subscription.
  if (
    invoice.metadata?.hackeraiLatePaymentResolution ||
    invoice.pre_payment_credit_notes_amount > 0 ||
    invoice.post_payment_credit_notes_amount > 0
  ) {
    return { status: "manual_review", reason: "invoice_changed_or_reconciled" };
  }

  for await (const other of stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
  })) {
    if (
      other.id !== subscription.id &&
      (other.created >= endedAt ||
        !["canceled", "incomplete_expired"].includes(other.status))
    ) {
      return {
        status: "manual_review",
        reason: "replacement_subscription_exists",
      };
    }
  }

  const refund = await stripe.refunds.create(
    {
      charge: chargeId,
      amount: invoice.amount_paid,
      metadata: {
        hackeraiReason: LATE_SUBSCRIPTION_PAYMENT_REFUND_REASON,
        stripeInvoiceId: invoice.id,
        stripeSubscriptionId: subscription.id,
      },
    },
    { idempotencyKey: `late-subscription-payment:${invoice.id}:${chargeId}` },
  );
  if (refund.status === "succeeded")
    return { status: "refunded", refundId: refund.id };
  if (refund.status === "pending" || refund.status === "requires_action") {
    return { status: "refund_pending", refundId: refund.id };
  }
  return { status: "manual_review", reason: "refund_failed_or_canceled" };
}
