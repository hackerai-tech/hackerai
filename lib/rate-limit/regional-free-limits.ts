import {
  getFreeMonthlyCostLimitDollars,
  getFreeRequestLimit,
  type FreeLimitPolicy,
} from "./free-config";

export const REGIONAL_FREE_COUNTRIES = ["IN", "PK", "BD", "NG"] as const;
export type RegionalFreeCountry = (typeof REGIONAL_FREE_COUNTRIES)[number];
export type RegionalFreeLimitsPolicy = FreeLimitPolicy & {
  country: RegionalFreeCountry;
};

export function isRegionalFreeCountry(
  value: unknown,
): value is RegionalFreeCountry {
  return REGIONAL_FREE_COUNTRIES.some((country) => country === value);
}

/** Country must come from consent-aware trusted ingress, never client input. */
export function getRegionalFreeLimits({
  userId,
  subscription,
  country,
}: {
  userId: string;
  subscription: string;
  country?: string;
}): RegionalFreeLimitsPolicy | undefined {
  if (!userId || subscription !== "free" || !isRegionalFreeCountry(country))
    return;
  return {
    country,
    dailyRequests: Math.min(3, getFreeRequestLimit()),
    monthlyCostDollars: Math.min(0.1, getFreeMonthlyCostLimitDollars()),
  };
}

export function regionalFreeLimitsProperties(
  policy?: RegionalFreeLimitsPolicy,
) {
  return policy
    ? {
        regional_free_policy_version: 1,
        regional_free_country: policy.country,
        regional_free_daily_requests: policy.dailyRequests,
        regional_free_monthly_cost_dollars: policy.monthlyCostDollars,
      }
    : {};
}
