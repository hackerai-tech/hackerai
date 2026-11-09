import {
  EXTRA_USAGE_BUNDLES,
  readExtraUsagePurchase,
  extraUsageBundlesEnabled,
} from "../extra-usage-bundles";

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
    expect(extraUsageBundlesEnabled("synthetic_non_allowlisted_user")).toBe(
      false,
    );
    if (before !== undefined) process.env.EXTRA_USAGE_BUNDLES_ENABLED = before;
  });
});
