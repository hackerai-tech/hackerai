import type Stripe from "stripe";
import { v5 as uuidv5 } from "uuid";
import {
  normalizeCheckoutAttemptId,
  normalizePaidFunnelLabel,
  paidFunnelProperties,
  PAID_FUNNEL_EVENTS,
} from "@/lib/analytics/paid-funnel";
import { phLogger } from "@/lib/posthog/server";
import {
  paymentFailureGroup,
  stripeObjectId,
} from "@/lib/billing/subscription-payment-failure";

const PAYMENT_EVENTS = {
  "payment_intent.payment_failed": PAID_FUNNEL_EVENTS.checkoutPaymentFailed,
  "payment_intent.requires_action":
    PAID_FUNNEL_EVENTS.checkoutPaymentRequiresAction,
  "payment_intent.canceled": PAID_FUNNEL_EVENTS.checkoutPaymentCanceled,
  "payment_intent.succeeded": PAID_FUNNEL_EVENTS.checkoutPaymentSucceeded,
} as const;

export function isCheckoutPaymentAnalyticsEvent(
  type: Stripe.Event.Type,
): boolean {
  return (
    type === "checkout.session.expired" || Object.hasOwn(PAYMENT_EVENTS, type)
  );
}

/** Initial Checkout attempts often fail before a subscription or invoice exists. */
export async function captureCheckoutPaymentAnalytics(
  stripe: Stripe,
  event: Stripe.Event,
): Promise<void> {
  if (!isCheckoutPaymentAnalyticsEvent(event.type)) return;

  let session: Stripe.Checkout.Session;
  let intent: Stripe.PaymentIntent | undefined;
  let charge: Stripe.Charge | undefined;
  if (event.type === "checkout.session.expired") {
    session = event.data.object as Stripe.Checkout.Session;
  } else {
    // Keep the historical payload: retrieving the current intent could turn a
    // delayed failure webhook into a success after the customer retries.
    intent = event.data.object as Stripe.PaymentIntent;
    const sessions = await stripe.checkout.sessions.list({
      payment_intent: intent.id,
      limit: 2,
    });
    // Exact Stripe linkage excludes renewals and unrelated customer payments.
    if (sessions.has_more || sessions.data.length !== 1) return;
    session = sessions.data[0];
    if (
      !stripeObjectId(intent.customer) ||
      stripeObjectId(session.customer) !== stripeObjectId(intent.customer) ||
      intent.livemode !== session.livemode ||
      intent.created < session.created ||
      intent.created > session.expires_at
    )
      return;
  }

  const metadata = session.metadata;
  const userId = metadata?.userId;
  if (
    session.mode !== "subscription" ||
    metadata?.checkoutType !== "new_subscription" ||
    !userId ||
    !/^user_[A-Za-z0-9]+$/.test(userId) ||
    event.livemode !== session.livemode
  )
    return;

  if (intent) {
    const chargeRef = intent.last_payment_error?.charge ?? intent.latest_charge;
    // Fetch only the charge referenced by this event, never the intent's newer charge.
    charge =
      typeof chargeRef === "string"
        ? await stripe.charges.retrieve(chargeRef)
        : (chargeRef ?? undefined);
  }
  const label = normalizePaidFunnelLabel;
  const failureCode = label(
    charge?.failure_code ?? intent?.last_payment_error?.code,
  );
  const declineCode = label(intent?.last_payment_error?.decline_code);
  const outcomeType = label(charge?.outcome?.type);
  const outcomeReason = label(charge?.outcome?.reason);
  const eventName =
    event.type === "checkout.session.expired"
      ? PAID_FUNNEL_EVENTS.checkoutExpired
      : PAYMENT_EVENTS[event.type as keyof typeof PAYMENT_EVENTS];
  const insertId = `${eventName}:${event.id}`;
  phLogger.event(eventName, {
    userId,
    eventUuid: uuidv5(insertId, uuidv5.URL),
    $insert_id: insertId,
    ...paidFunnelProperties({
      stripe_event_id: event.id,
      stripe_event_type: event.type,
      stripe_event_created_at: new Date(event.created * 1000).toISOString(),
      stripe_livemode: event.livemode,
      stripe_checkout_session_id: session.id,
      stripe_customer_id: stripeObjectId(session.customer),
      stripe_payment_intent_id: intent?.id,
      stripe_charge_id: charge?.id,
      checkout_session_created_at: new Date(
        session.created * 1000,
      ).toISOString(),
      checkout_session_expires_at: new Date(
        session.expires_at * 1000,
      ).toISOString(),
      // Session reuse can update metadata; the session ID is the stable funnel key.
      checkout_attempt_id: normalizeCheckoutAttemptId(
        metadata.checkoutAttemptId,
      ),
      checkout_attribution_source: "session_metadata_at_webhook",
      checkout_type: "new_subscription",
      source: label(metadata.checkoutSource),
      surface: label(metadata.checkoutSurface),
      reason: label(metadata.checkoutReason),
      limit_type: label(metadata.checkoutLimitType),
      requested_plan: label(metadata.requestedPlan),
      resolved_price_lookup_key: label(metadata.resolvedPriceLookupKey),
      pricing_experiment_key: label(metadata.pricingExperimentKey),
      pricing_experiment_variant: label(metadata.pricingExperimentVariant),
      payment_intent_status: intent?.status,
      cancellation_reason: label(intent?.cancellation_reason),
      currency: label(intent?.currency ?? session.currency),
      amount_minor_units: intent?.amount ?? session.amount_total,
      failure_code: failureCode,
      decline_code: declineCode,
      outcome_type: outcomeType,
      outcome_reason: outcomeReason,
      risk_level: label(charge?.outcome?.risk_level),
      network_status: label(charge?.outcome?.network_status),
      billing_failure_group:
        failureCode ||
        declineCode ||
        outcomeType === "blocked" ||
        outcomeType === "issuer_declined"
          ? paymentFailureGroup({
              failureCode,
              declineCode,
              outcomeType,
              outcomeReason,
            })
          : undefined,
    }),
  });
}
