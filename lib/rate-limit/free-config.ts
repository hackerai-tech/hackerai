export const FREE_MONTHLY_COST_LIMIT_USD_DEFAULT = 0.25;
export const FREE_RUN_LOCK_TTL_SECONDS = 15 * 60;
export const FREE_AGENT_LONG_RUN_LOCK_TTL_SECONDS = 65 * 60;
export const FREE_MAX_CONTEXT_TOKENS = 128000;
export const FREE_RATE_LIMIT_REQUESTS_DEFAULT = 10;
export const FREE_ASK_REQUEST_COST = 1;
export const FREE_AGENT_REQUEST_COST = 1;

export type FreeLimitPolicy = {
  dailyRequests: number;
  monthlyCostDollars: number;
};

export const getFreeRequestLimit = (policy?: FreeLimitPolicy): number => {
  const configuredLimit = parseInt(
    process.env.FREE_RATE_LIMIT_REQUESTS || "",
    10,
  );
  const normal =
    Number.isFinite(configuredLimit) && configuredLimit > 0
      ? configuredLimit
      : FREE_RATE_LIMIT_REQUESTS_DEFAULT;
  return policy &&
    Number.isFinite(policy.dailyRequests) &&
    policy.dailyRequests >= 1
    ? Math.min(normal, Math.floor(policy.dailyRequests))
    : normal;
};

export const getFreeMonthlyCostLimitDollars = (
  policy?: FreeLimitPolicy,
): number => {
  const configuredLimit = Number(process.env.FREE_MONTHLY_COST_LIMIT_USD);
  const normal =
    Number.isFinite(configuredLimit) && configuredLimit > 0
      ? configuredLimit
      : FREE_MONTHLY_COST_LIMIT_USD_DEFAULT;
  return policy &&
    Number.isFinite(policy.monthlyCostDollars) &&
    policy.monthlyCostDollars > 0
    ? Math.min(normal, policy.monthlyCostDollars)
    : normal;
};
