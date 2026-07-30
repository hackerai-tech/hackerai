import {
  HACKERAI_PRO_20_MONTHLY_PRICE_ID,
  PENTESTGPT_PRO_20_MONTHLY_PRICE_ID,
  PRO_20_MONTHLY_INCLUDED_USAGE_POINTS,
  includedUsagePointsForStripePrice,
  pentestgptMigrationPriceOverride,
} from "@/lib/billing/included-usage";

describe("price-specific included usage", () => {
  it.each([
    HACKERAI_PRO_20_MONTHLY_PRICE_ID,
    PENTESTGPT_PRO_20_MONTHLY_PRICE_ID,
  ])("maps %s to the grandfathered $20 allowance", (priceId) => {
    expect(includedUsagePointsForStripePrice(priceId)).toBe(
      PRO_20_MONTHLY_INCLUDED_USAGE_POINTS,
    );
  });

  it("uses the tier default for every other price", () => {
    expect(includedUsagePointsForStripePrice("price_pro_25")).toBeUndefined();
    expect(includedUsagePointsForStripePrice(null)).toBeUndefined();
  });

  it("preserves the $20 price when a matching PentestGPT user migrates", () => {
    expect(
      pentestgptMigrationPriceOverride(PENTESTGPT_PRO_20_MONTHLY_PRICE_ID),
    ).toBe(HACKERAI_PRO_20_MONTHLY_PRICE_ID);
    expect(
      pentestgptMigrationPriceOverride("price_legacy_other"),
    ).toBeUndefined();
  });
});
