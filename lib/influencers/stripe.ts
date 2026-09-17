import type Stripe from "stripe";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { anniversary } from "./policy";

const objectId = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : value?.id;

async function bounded<T>(items: AsyncIterable<T>, limit = 1000): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) {
    if (result.length >= limit)
      throw new Error("Influencer reconciliation exceeds pilot capacity");
    result.push(item);
  }
  return result;
}

async function invoiceInterval(stripe: Stripe, invoice: Stripe.Invoice) {
  const lines = invoice.lines.has_more
    ? await bounded(stripe.invoices.listLineItems(invoice.id, { limit: 100 }))
    : invoice.lines.data;
  const intervals = new Set<string>();
  if (!lines.length) return "unsupported";
  for (const line of lines) {
    const priceId = objectId(line.pricing?.price_details?.price);
    if (!line.parent?.subscription_item_details || !priceId)
      return "unsupported";
    const price = await stripe.prices.retrieve(priceId);
    if (!price.recurring || price.recurring.interval_count !== 1)
      return "unsupported";
    intervals.add(price.recurring.interval);
  }
  return intervals.size === 1 ? [...intervals][0] : "unsupported";
}

/** Read Stripe's current state instead of trusting the arrival order of events. */
export async function reconcileInfluencerInvoice(
  stripe: Stripe,
  convex: ConvexHttpClient,
  invoiceId: string,
) {
  const observedAt = Date.now();
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;
  const invoice = await stripe.invoices.retrieve(invoiceId);
  const customerId = objectId(invoice.customer);
  const subscriptionId = objectId(
    invoice.parent?.subscription_details?.subscription,
  );
  if (
    !customerId ||
    !subscriptionId ||
    invoice.status !== "paid" ||
    invoice.amount_paid <= 0
  )
    return;
  const attribution = await convex.query(
    api.influencers.getCustomerAttribution,
    { serviceKey, customerId },
  );
  if (
    !attribution ||
    (attribution.subscription_id &&
      attribution.subscription_id !== subscriptionId)
  )
    return;
  const paidAt = (invoice.status_transitions.paid_at ?? 0) * 1000;
  if (!paidAt) throw new Error("Paid invoice has no payment timestamp");
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (subscription.created < Math.floor(attribution.created_at / 1000)) return;
  if (!attribution.subscription_id) {
    const subscriptions = (
      await bounded(
        stripe.subscriptions.list({
          customer: customerId,
          status: "all",
          limit: 100,
        }),
      )
    ).sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
    if (subscriptions[0]?.id !== subscriptionId) return;
  }

  const history = (
    await bounded(
      stripe.invoices.list({
        subscription: subscriptionId,
        status: "paid",
        limit: 100,
      }),
    )
  )
    .filter((row) => row.amount_paid > 0 && row.status_transitions.paid_at)
    .sort(
      (a, b) =>
        a.status_transitions.paid_at! - b.status_transitions.paid_at! ||
        a.created - b.created ||
        a.id.localeCompare(b.id),
    );
  const first = history[0];
  if (!first) throw new Error("Paid invoice history unavailable");
  const interval = await invoiceInterval(stripe, invoice);
  let eligible = paidAt < anniversary(first.status_transitions.paid_at! * 1000);
  if (interval === "year") {
    for (const row of history) {
      if ((await invoiceInterval(stripe, row)) === "year") {
        eligible &&= row.id === invoice.id;
        break;
      }
    }
  }
  let reviewReason: string | undefined;
  if (interval !== "month" && interval !== "year")
    reviewReason = "unsupported_invoice_lines";
  if (invoice.currency !== "usd") reviewReason = "unsupported_currency";
  if (invoice.total_excluding_tax == null || invoice.total <= 0)
    reviewReason = "missing_tax_basis";

  const payments = await bounded(
    stripe.invoicePayments.list({
      invoice: invoice.id,
      status: "paid",
      limit: 100,
    }),
  );
  let collected = 0;
  let refunded = 0;
  const chargeIds = new Set<string>();
  for (const payment of payments) {
    let chargeId = objectId(payment.payment.charge);
    const intentId = objectId(payment.payment.payment_intent);
    if (intentId)
      chargeId = objectId(
        (await stripe.paymentIntents.retrieve(intentId)).latest_charge,
      );
    if (!chargeId) {
      reviewReason = "unsupported_payment";
      continue;
    }
    if (chargeIds.has(chargeId)) {
      reviewReason = "shared_charge";
      continue;
    }
    chargeIds.add(chargeId);
    const charge = await stripe.charges.retrieve(chargeId);
    // Shared/partial payments need allocation rather than charging one invoice for all refunds.
    if (
      !charge.paid ||
      charge.amount_captured !== payment.amount_paid ||
      charge.currency !== invoice.currency
    ) {
      reviewReason = "payment_allocation_review";
      continue;
    }
    collected += payment.amount_paid ?? 0;
    refunded += charge.amount_refunded;
    const refunds = await bounded(
      stripe.refunds.list({ charge: chargeId, limit: 100 }),
    );
    if (
      refunds.some(
        (row) => row.status === "pending" || row.status === "requires_action",
      )
    )
      reviewReason = "pending_refund";
    if (charge.disputed) {
      const disputes = await bounded(
        stripe.disputes.list({ charge: chargeId, limit: 100 }),
      );
      if (!disputes.length) reviewReason = "dispute_lookup_review";
      for (const dispute of disputes) {
        if (dispute.status === "lost") eligible = false;
        else if (
          dispute.status !== "won" &&
          dispute.status !== "warning_closed"
        )
          reviewReason = "open_dispute";
      }
    }
  }
  if (!payments.length || collected <= 0 || invoice.amount_paid_off_stripe)
    reviewReason = "no_verified_stripe_payment";
  // Credit notes may refund charges already counted above. Deduct only their
  // non-refund component here, including customer-balance and external credits.
  const creditNotes = await bounded(
    stripe.creditNotes.list({ invoice: invoice.id, limit: 100 }),
  );
  const otherCredits = creditNotes
    .filter((row) => row.status !== "void")
    .reduce(
      (sum, row) =>
        sum +
        Math.max(
          0,
          row.post_payment_amount -
            row.refunds.reduce((n, refund) => n + refund.amount_refunded, 0),
        ),
      0,
    );
  const retained = Math.max(
    0,
    Math.min(collected, invoice.amount_paid, invoice.total) -
      refunded -
      otherCredits,
  );
  const netCents =
    invoice.total > 0
      ? Math.floor(
          (retained * Math.max(0, invoice.total_excluding_tax ?? 0)) /
            invoice.total,
        )
      : 0;
  await convex.mutation(api.influencers.syncInvoice, {
    serviceKey,
    invoiceId: invoice.id,
    customerId,
    subscriptionId,
    currency: invoice.currency,
    interval,
    paidAt,
    grossCents: invoice.amount_paid,
    netCents,
    eligible,
    ...(reviewReason ? { reviewReason } : {}),
    observedAt,
  });
}

/** Used both for repair/backfill and immediately before reserving a payout. */
export async function reconcileInfluencerCustomer(
  stripe: Stripe,
  convex: ConvexHttpClient,
  customerId: string,
) {
  for (const invoice of await bounded(
    stripe.invoices.list({ customer: customerId, status: "paid", limit: 100 }),
  )) {
    await reconcileInfluencerInvoice(stripe, convex, invoice.id);
  }
}

export async function handleInfluencerEvent(
  stripe: Stripe,
  convex: ConvexHttpClient,
  event: Stripe.Event,
) {
  if (event.type === "invoice.paid") {
    await reconcileInfluencerInvoice(
      stripe,
      convex,
      (event.data.object as Stripe.Invoice).id,
    );
  } else if (
    [
      "charge.refunded",
      "charge.dispute.created",
      "charge.dispute.updated",
      "charge.dispute.closed",
      "refund.updated",
      "credit_note.created",
      "credit_note.updated",
      "credit_note.voided",
    ].includes(event.type)
  ) {
    let customerId: string | undefined;
    if (event.type.startsWith("credit_note.")) {
      await reconcileInfluencerInvoice(
        stripe,
        convex,
        objectId((event.data.object as Stripe.CreditNote).invoice)!,
      );
      return;
    }
    const chargeId =
      event.type === "charge.refunded"
        ? (event.data.object as Stripe.Charge).id
        : objectId(
            (event.data.object as Stripe.Dispute | Stripe.Refund).charge,
          );
    const charge = chargeId ? await stripe.charges.retrieve(chargeId) : null;
    customerId = objectId(charge?.customer);
    if (
      customerId &&
      (await convex.query(api.influencers.getCustomerAttribution, {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        customerId,
      }))
    ) {
      // Modern Stripe Charges no longer expose invoice. InvoicePayment is the
      // supported mapping from a PaymentIntent to the affected invoices.
      const intentId = objectId(charge?.payment_intent);
      const payments = intentId
        ? await bounded(
            stripe.invoicePayments.list({
              payment: { type: "payment_intent", payment_intent: intentId },
              status: "paid",
              limit: 100,
            }),
          )
        : [];
      const invoiceIds = new Set(
        payments
          .map((payment) => objectId(payment.invoice))
          .filter((id): id is string => !!id),
      );
      if (invoiceIds.size) {
        for (const invoiceId of invoiceIds)
          await reconcileInfluencerInvoice(stripe, convex, invoiceId);
      } else {
        await reconcileInfluencerCustomer(stripe, convex, customerId);
      }
    }
  }
}
