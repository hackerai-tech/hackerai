/** Current HackerAI Pro price retained by grandfathered $20/month customers. */
export const HACKERAI_PRO_20_MONTHLY_PRICE_ID =
  "price_1S7i1qFAn4ulhcn1kyxA8jp6";

/** Legacy PentestGPT Pro price used to identify $20/month migrations. */
export const PENTESTGPT_PRO_20_MONTHLY_PRICE_ID =
  "price_1OhIo2FAn4ulhcn1JyrRXnwe";

/** Included provider/tool usage for the grandfathered $20/month Pro variant. */
export const PRO_20_MONTHLY_INCLUDED_USAGE_POINTS = 200_000;

const PRO_20_MONTHLY_PRICE_IDS = new Set([
  HACKERAI_PRO_20_MONTHLY_PRICE_ID,
  PENTESTGPT_PRO_20_MONTHLY_PRICE_ID,
]);

/** Return a price-specific included-usage cap, or undefined for tier defaults. */
export function includedUsagePointsForStripePrice(
  priceId: string | null | undefined,
): number | undefined {
  return priceId && PRO_20_MONTHLY_PRICE_IDS.has(priceId)
    ? PRO_20_MONTHLY_INCLUDED_USAGE_POINTS
    : undefined;
}

/** Keep grandfathered PentestGPT $20 customers on the HackerAI $20 price. */
export function pentestgptMigrationPriceOverride(
  legacyPriceId: string | null | undefined,
): string | undefined {
  return legacyPriceId === PENTESTGPT_PRO_20_MONTHLY_PRICE_ID
    ? HACKERAI_PRO_20_MONTHLY_PRICE_ID
    : undefined;
}
