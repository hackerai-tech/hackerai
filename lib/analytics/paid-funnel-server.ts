import { v5 as uuidv5 } from "uuid";
import { checkoutStartedInsertId } from "./paid-funnel";

export function checkoutStartedEventUuid(checkoutAttemptId: string): string {
  return uuidv5(checkoutStartedInsertId(checkoutAttemptId), uuidv5.URL);
}

/** Bump when subscription_started identity or timing semantics change. */
export const PAID_START_ANALYTICS_VERSION = 2;

export type SubscriptionStartedAttribution = {
  /** Stable per invoice and user, so Stripe redeliveries share one event. */
  eventUuid: string;
  /** When the invoice was actually paid, not when the webhook arrived. */
  eventTimestamp: Date;
  invoice_paid_at: number | null;
  paid_start_analytics_version: typeof PAID_START_ANALYTICS_VERSION;
  paid_start_timestamp_source: "paid_at" | "event_created";
  stripe_event_id: string;
};

const positiveFiniteMs = (value: number): number | undefined =>
  Number.isFinite(value) &&
  value > 0 &&
  Number.isFinite(new Date(value).getTime())
    ? value
    : undefined;

/**
 * Identity and economic time for subscription_started. Pure: no I/O.
 *
 * The UUID is scoped to subscription_started + invoice + user, not to the
 * Stripe delivery event, so redeliveries or different event IDs for the
 * same paid invoice collapse to one event. The timestamp is the invoice's
 * paid_at when valid; otherwise the trusted Stripe event occurrence time.
 * Invoice creation time is deliberately not used.
 */
export function subscriptionStartedAttribution({
  userId,
  invoiceId,
  stripeEventId,
  invoicePaidAtSeconds,
  eventOccurredAtMs,
}: {
  userId: string;
  invoiceId: string;
  stripeEventId: string;
  invoicePaidAtSeconds?: number | null;
  eventOccurredAtMs: number;
}): SubscriptionStartedAttribution {
  const paidAtMs =
    typeof invoicePaidAtSeconds === "number"
      ? positiveFiniteMs(invoicePaidAtSeconds * 1000)
      : undefined;
  const occurredAtMs = positiveFiniteMs(eventOccurredAtMs) ?? Date.now();
  return {
    eventUuid: uuidv5(
      `subscription_started:${invoiceId}:${userId}`,
      uuidv5.URL,
    ),
    eventTimestamp: new Date(paidAtMs ?? occurredAtMs),
    invoice_paid_at: paidAtMs ?? null,
    paid_start_analytics_version: PAID_START_ANALYTICS_VERSION,
    paid_start_timestamp_source:
      paidAtMs !== undefined ? "paid_at" : "event_created",
    stripe_event_id: stripeEventId,
  };
}
