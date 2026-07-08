import type Stripe from "stripe";

export type BillingFailureLifecycle =
  "invoice_payment_failed" | "subscription_deleted";

export type BillingFailureProperties = {
  billing_failure_lifecycle: BillingFailureLifecycle;
  billing_failure_stage: string;
  billing_failure_group: string;
  billing_reason?: string;
  invoice_status?: string | null;
  collection_method?: string | null;
  attempt_count?: number;
  next_payment_attempt_present?: boolean;
  amount_due_dollars?: number;
  amount_remaining_dollars?: number;
  currency?: string | null;
  stripe_invoice_id: string;
  stripe_payment_intent_id?: string;
  stripe_charge_id?: string;
  failure_code?: string | null;
  decline_code?: string | null;
  outcome_type?: string | null;
  outcome_reason?: string | null;
  network_status?: string | null;
  network_decline_code?: string | null;
  risk_level?: string | null;
  payment_method_type?: string;
  card_brand?: string | null;
  card_country?: string | null;
  card_funding?: string | null;
};

const centsToDollars = (
  amount: number | null | undefined,
): number | undefined =>
  typeof amount === "number" && Number.isFinite(amount)
    ? amount / 100
    : undefined;

export function stripeObjectId(
  value: string | { id?: string | null } | null | undefined,
): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (
    value &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    value.id.length > 0
  ) {
    return value.id;
  }
  return undefined;
}

export function invoiceSubscriptionId(
  invoice: Stripe.Invoice,
): string | undefined {
  const parentSubscription = invoice.parent?.subscription_details?.subscription;
  const parentSubscriptionId = stripeObjectId(parentSubscription);
  if (parentSubscriptionId) return parentSubscriptionId;

  return stripeObjectId(
    (invoice as unknown as { subscription?: string | { id?: string } | null })
      .subscription,
  );
}

function expandedPaymentIntent(
  invoice: Stripe.Invoice,
): Stripe.PaymentIntent | undefined {
  const paymentIntent = (
    invoice as unknown as {
      payment_intent?: string | Stripe.PaymentIntent | null;
    }
  ).payment_intent;

  return paymentIntent && typeof paymentIntent === "object"
    ? paymentIntent
    : undefined;
}

function paymentIntentId(invoice: Stripe.Invoice): string | undefined {
  const paymentIntent = (
    invoice as unknown as {
      payment_intent?: string | Stripe.PaymentIntent | null;
    }
  ).payment_intent;

  return stripeObjectId(paymentIntent);
}

function latestCharge(
  paymentIntent: Stripe.PaymentIntent | undefined,
): Stripe.Charge | undefined {
  const charge = paymentIntent?.latest_charge;
  return charge && typeof charge === "object" ? charge : undefined;
}

function normalizedBillingStage(invoice: Stripe.Invoice): string {
  const reason = invoice.billing_reason;
  if (reason === "subscription_create") return "first_payment";
  if (reason === "subscription_cycle") return "renewal";
  if (reason === "subscription_update") return "subscription_update";
  if (reason === "subscription_threshold") return "subscription_threshold";
  if (reason === "manual") return "manual_invoice";
  return reason ?? "unknown";
}

function failureGroup(args: {
  failureCode?: string | null;
  declineCode?: string | null;
  outcomeType?: string | null;
  outcomeReason?: string | null;
}): string {
  const values = [
    args.failureCode,
    args.declineCode,
    args.outcomeType,
    args.outcomeReason,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());

  if (
    values.includes("blocked") ||
    values.includes("highest_risk_level") ||
    values.includes("elevated_risk_level")
  ) {
    return "stripe_risk_block";
  }
  if (values.includes("insufficient_funds")) return "insufficient_funds";
  if (values.includes("transaction_not_allowed")) {
    return "transaction_not_allowed";
  }
  if (values.includes("do_not_honor")) return "do_not_honor";
  if (
    values.includes("authentication_required") ||
    values.includes("payment_intent_authentication_failure")
  ) {
    return "authentication_failed";
  }
  if (values.includes("expired_card")) return "expired_card";
  if (values.includes("incorrect_number")) return "incorrect_card_details";
  if (values.includes("generic_decline")) return "generic_decline";
  if (
    values.includes("link_connection_closed") ||
    values.includes("payment_method_unactivated") ||
    values.includes("payment_method_provider_decline")
  ) {
    return "payment_method_unavailable";
  }
  if (values.includes("card_declined")) return "card_declined";
  return "unknown";
}

export function subscriptionPaymentFailureProperties({
  invoice,
  lifecycle,
}: {
  invoice: Stripe.Invoice;
  lifecycle: BillingFailureLifecycle;
}): BillingFailureProperties {
  const paymentIntent = expandedPaymentIntent(invoice);
  const charge = latestCharge(paymentIntent);
  const lastPaymentError = paymentIntent?.last_payment_error;
  const card = charge?.payment_method_details?.card;
  const paymentMethodType =
    charge?.payment_method_details?.type ??
    lastPaymentError?.payment_method?.type ??
    undefined;
  const failureCode = charge?.failure_code ?? lastPaymentError?.code;
  const declineCode =
    lastPaymentError?.decline_code ??
    (charge as Stripe.Charge | undefined)?.outcome?.network_decline_code ??
    undefined;
  const outcome = charge?.outcome;

  return {
    billing_failure_lifecycle: lifecycle,
    billing_failure_stage: normalizedBillingStage(invoice),
    billing_failure_group: failureGroup({
      failureCode,
      declineCode,
      outcomeType: outcome?.type,
      outcomeReason: outcome?.reason,
    }),
    billing_reason: invoice.billing_reason ?? undefined,
    invoice_status: invoice.status,
    collection_method: invoice.collection_method,
    attempt_count: invoice.attempt_count ?? undefined,
    next_payment_attempt_present: Boolean(invoice.next_payment_attempt),
    amount_due_dollars: centsToDollars(invoice.amount_due),
    amount_remaining_dollars: centsToDollars(invoice.amount_remaining),
    currency: invoice.currency,
    stripe_invoice_id: invoice.id,
    stripe_payment_intent_id: paymentIntentId(invoice),
    stripe_charge_id:
      stripeObjectId(charge) ?? stripeObjectId(lastPaymentError?.charge),
    failure_code: failureCode,
    decline_code: declineCode,
    outcome_type: outcome?.type,
    outcome_reason: outcome?.reason,
    network_status: outcome?.network_status,
    network_decline_code: outcome?.network_decline_code,
    risk_level: outcome?.risk_level,
    payment_method_type: paymentMethodType,
    card_brand: card?.brand,
    card_country: card?.country,
    card_funding: card?.funding,
  };
}
