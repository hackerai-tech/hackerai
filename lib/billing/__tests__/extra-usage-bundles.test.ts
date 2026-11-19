import {
  EXTRA_USAGE_BUNDLES,
  readExtraUsagePurchase,
  extraUsageBundlesEnabled,
  extraUsageBundleCapPeriod,
  extraUsagePurchaseValueProperties,
} from "../extra-usage-bundles";

describe("bundle cap period", () => {
  it.each([
    [Date.UTC(2026, 10, 30, 23, 59, 59, 999), "2026-11", Date.UTC(2026, 11, 1)],
    [Date.UTC(2026, 11, 1), "2026-12", Date.UTC(2027, 0, 1)],
    [Date.UTC(2026, 11, 31, 23, 59, 59, 999), "2026-12", Date.UTC(2027, 0, 1)],
  ])("assigns %s to UTC month %s", (now, periodMonth, resetsAt) => {
    expect(extraUsageBundleCapPeriod(now)).toMatchObject({
      periodMonth,
      resetsAt,
    });
  });
});

describe("bundle fulfillment metadata", () => {
  it("carries the reservation and its period through to fulfillment analytics", () => {
    const purchase = readExtraUsagePurchase({
      metadata: {
        bundleId: "usage-1000-v1",
        amountDollars: "1000",
        paidAmountDollars: "700",
        bundleReservationId: "reservation_fixture",
        bundleCapPeriod: "2026-11",
        bundleCapPolicyVersion: "bundle-cap-v1",
      },
      currency: "usd",
      amount_total: 70000,
    });
    expect(purchase.bundleReservationId).toBe("reservation_fixture");
    expect(extraUsagePurchaseValueProperties(purchase)).toEqual({
      amount_dollars: 700,
      credit_amount_dollars: 1000,
      discount_dollars: 300,
      bundle_id: "usage-1000-v1",
      bundle_cap_policy_version: "bundle-cap-v1",
      bundle_cap_period: "2026-11",
    });
    expect(
      extraUsagePurchaseValueProperties(
        readExtraUsagePurchase({ metadata: { amountDollars: "75" } }),
      ),
    ).toMatchObject({ amount_dollars: 75, discount_dollars: 0 });
  });
});

describe("bundle checkout fulfillment", () => {
  it.each(EXTRA_USAGE_BUNDLES)(
    "validates $creditDollars credit against $paidDollars paid",
    (b) => {
      const session = {
        metadata: {
          bundleId: b.id,
          amountDollars: String(b.creditDollars),
          paidAmountDollars: String(b.paidDollars),
        },
        currency: "usd",
        amount_total: b.paidDollars * 100,
      };
      expect(readExtraUsagePurchase(session)).toEqual({
        amountDollars: b.creditDollars,
        paidAmountDollars: b.paidDollars,
        bundleId: b.id,
      });
      expect(() =>
        readExtraUsagePurchase({ ...session, amount_total: 1 }),
      ).toThrow();
      expect(() =>
        readExtraUsagePurchase({ ...session, currency: "eur" }),
      ).toThrow();
      expect(() =>
        readExtraUsagePurchase({
          ...session,
          metadata: { ...session.metadata, amountDollars: "100000" },
        }),
      ).toThrow();
      expect(() =>
        readExtraUsagePurchase({
          ...session,
          metadata: { ...session.metadata, bundleId: "unknown" },
        }),
      ).toThrow();
    },
  );
  it("preserves legacy purchases and rejects nonfinite amounts", () => {
    expect(
      readExtraUsagePurchase({ metadata: { amountCents: "1500" } }),
    ).toEqual({ amountDollars: 15 });
    expect(() =>
      readExtraUsagePurchase({ metadata: { amountDollars: "Infinity" } }),
    ).toThrow();
  });
  it("rejects cash metadata without an offer", () => {
    expect(() =>
      readExtraUsagePurchase({
        metadata: { amountDollars: "250", paidAmountDollars: "200" },
      }),
    ).toThrow("Paid amount requires a bundle");
  });
  it("defaults sales off without disabling paid fulfillment", () => {
    const before = process.env.EXTRA_USAGE_BUNDLES_ENABLED;
    delete process.env.EXTRA_USAGE_BUNDLES_ENABLED;
    try {
      expect(extraUsageBundlesEnabled("synthetic_non_allowlisted_user")).toBe(
        false,
      );
    } finally {
      if (before !== undefined)
        process.env.EXTRA_USAGE_BUNDLES_ENABLED = before;
      else delete process.env.EXTRA_USAGE_BUNDLES_ENABLED;
    }
  });
});
