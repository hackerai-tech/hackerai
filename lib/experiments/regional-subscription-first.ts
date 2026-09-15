export const REGIONAL_SUBSCRIPTION_FIRST_KEY = "regional_subscription_first_v1";
export const REGIONAL_SUBSCRIPTION_FIRST_EXPOSURE =
  "regional_subscription_first_exposed";
export const SUBSCRIPTION_FIRST_COUNTRIES = ["IN", "PK", "BD", "NG"] as const;

export type RegionalSubscriptionAssignment = {
  variant: "control" | "test";
  country: (typeof SUBSCRIPTION_FIRST_COUNTRIES)[number];
};

export function isSubscriptionFirstCountry(
  country: unknown,
): country is RegionalSubscriptionAssignment["country"] {
  return SUBSCRIPTION_FIRST_COUNTRIES.some((value) => value === country);
}

export function regionalSubscriptionProperties(
  assignment: RegionalSubscriptionAssignment,
) {
  return {
    [`$feature/${REGIONAL_SUBSCRIPTION_FIRST_KEY}`]: assignment.variant,
    regional_subscription_variant: assignment.variant,
    regional_subscription_country: assignment.country,
  };
}
