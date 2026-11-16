import { describe, expect, it } from "@jest/globals";
import { subscriptionStartedAttribution } from "../paid-funnel-server";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PAID_AT_SECONDS = 1_782_000_000;
const DELIVERED_AT_MS = 1_782_090_000_000; // a day after payment

const base = {
  userId: "user_1",
  invoiceId: "in_1",
  stripeEventId: "evt_1",
  invoicePaidAtSeconds: PAID_AT_SECONDS,
  eventOccurredAtMs: DELIVERED_AT_MS,
};

describe("subscriptionStartedAttribution", () => {
  it("keeps one identity across Stripe redeliveries and event IDs for the same invoice and user", () => {
    const first = subscriptionStartedAttribution(base);
    const redelivered = subscriptionStartedAttribution({
      ...base,
      stripeEventId: "evt_2",
      eventOccurredAtMs: DELIVERED_AT_MS + 60_000,
    });

    expect(first.eventUuid).toMatch(UUID);
    expect(redelivered.eventUuid).toBe(first.eventUuid);
    expect(redelivered.eventTimestamp).toEqual(first.eventTimestamp);
    // The delivery event stays traceable without defining identity.
    expect(first.stripe_event_id).toBe("evt_1");
    expect(redelivered.stripe_event_id).toBe("evt_2");
  });

  it.each([
    ["another user on the same invoice (team seat)", { userId: "user_2" }],
    ["another invoice for the same user", { invoiceId: "in_2" }],
  ])("gives %s a different identity", (_, change) => {
    expect(
      subscriptionStartedAttribution({ ...base, ...change }).eventUuid,
    ).not.toBe(subscriptionStartedAttribution(base).eventUuid);
  });

  it("times a delayed webhook at the actual payment, not its arrival", () => {
    const attribution = subscriptionStartedAttribution(base);

    expect(attribution.eventTimestamp.getTime()).toBe(PAID_AT_SECONDS * 1000);
    expect(attribution).toMatchObject({
      invoice_paid_at: PAID_AT_SECONDS * 1000,
      paid_start_timestamp_source: "paid_at",
      paid_start_analytics_version: 2,
    });
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["zero", 0],
    ["negative", -1],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["beyond the representable date range", 9e15],
  ])("falls back to the Stripe event time when paid_at is %s", (_, paidAt) => {
    const attribution = subscriptionStartedAttribution({
      ...base,
      invoicePaidAtSeconds: paidAt,
    });

    expect(attribution.eventTimestamp.getTime()).toBe(DELIVERED_AT_MS);
    expect(attribution).toMatchObject({
      invoice_paid_at: null,
      paid_start_timestamp_source: "event_created",
    });
    // Identity does not depend on timing.
    expect(attribution.eventUuid).toBe(
      subscriptionStartedAttribution(base).eventUuid,
    );
  });
});
