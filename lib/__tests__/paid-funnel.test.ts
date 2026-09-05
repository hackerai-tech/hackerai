import {
  PAID_FUNNEL_EVENT_VERSION,
  checkoutStartedInsertId,
  normalizePaidFunnelLabel,
  paidFunnelProperties,
  subscriptionChurnHealthProperties,
  upgradeCtaImpressionInsertId,
} from "@/lib/analytics/paid-funnel";

describe("paid funnel analytics helpers", () => {
  it.each([
    ["cancellation_requested", "voluntary", true, false],
    ["payment_failed", "involuntary", false, true],
    ["payment_disputed", "dispute", false, false],
    [null, "unknown", false, false],
  ] as const)(
    "classifies Stripe cancellation reason %p as %s",
    (reason, churnType, voluntaryChurn, involuntaryChurn) => {
      expect(subscriptionChurnHealthProperties(reason)).toEqual({
        churn_type: churnType,
        voluntary_churn: voluntaryChurn,
        involuntary_churn: involuntaryChurn,
      });
    },
  );

  it("keeps the paid funnel event version authoritative", () => {
    expect(
      paidFunnelProperties({
        paid_funnel_event_version: 999,
        surface: "pricing_dialog",
      }),
    ).toEqual({
      paid_funnel_event_version: PAID_FUNNEL_EVENT_VERSION,
      surface: "pricing_dialog",
    });
  });

  it("accepts only compact analytics labels", () => {
    expect(normalizePaidFunnelLabel("pricing_dialog")).toBe("pricing_dialog");
    expect(normalizePaidFunnelLabel(" user@example.com ")).toBeUndefined();
    expect(normalizePaidFunnelLabel("free form label")).toBeUndefined();
  });

  it("keeps checkout insert IDs stable per logical attempt", () => {
    expect(checkoutStartedInsertId("ca_attempt_123")).toBe(
      "checkout_started:ca_attempt_123",
    );
  });

  it("keeps upgrade impression insert IDs stable per identified-user UTC day", () => {
    const impression = {
      distinctId: "user_123",
      surface: "pricing_dialog",
      source: "plan_cards",
      utcDay: "2026-07-18",
    };

    expect(upgradeCtaImpressionInsertId(impression)).toBe(
      upgradeCtaImpressionInsertId(impression),
    );
    expect(
      upgradeCtaImpressionInsertId({
        ...impression,
        utcDay: "2026-07-19",
      }),
    ).not.toBe(upgradeCtaImpressionInsertId(impression));
    expect(
      upgradeCtaImpressionInsertId({
        ...impression,
        distinctId: "user_456",
      }),
    ).not.toBe(upgradeCtaImpressionInsertId(impression));
    expect(
      upgradeCtaImpressionInsertId({
        ...impression,
        surface: "rate_limit_warning",
      }),
    ).not.toBe(upgradeCtaImpressionInsertId(impression));
    expect(
      upgradeCtaImpressionInsertId({
        ...impression,
        source: "limit_pressure",
      }),
    ).not.toBe(upgradeCtaImpressionInsertId(impression));
  });
});
