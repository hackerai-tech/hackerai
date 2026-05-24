export const FREE_MONTHLY_COST_LIMIT_USD_DEFAULT = 0.25;
export const FREE_RUN_LOCK_TTL_SECONDS = 15 * 60;
export const FREE_AGENT_LONG_RUN_LOCK_TTL_SECONDS = 65 * 60;
export const PAID_MAX_OUTPUT_TOKENS = 30000;
export const FREE_MAX_OUTPUT_TOKENS = PAID_MAX_OUTPUT_TOKENS / 2;
export const FREE_MAX_CONTEXT_TOKENS = 128000;
export const FREE_RATE_LIMIT_REQUESTS_DEFAULT = 10;
export const FREE_ASK_REQUEST_COST = 1;
export const FREE_AGENT_REQUEST_COST = 2;

export const getFreeRequestLimit = (): number => {
  const configuredLimit = parseInt(
    process.env.FREE_RATE_LIMIT_REQUESTS || "",
    10,
  );
  return Number.isFinite(configuredLimit) && configuredLimit > 0
    ? configuredLimit
    : FREE_RATE_LIMIT_REQUESTS_DEFAULT;
};

export const getFreeMonthlyCostLimitDollars = (): number => {
  const configuredLimit = Number(process.env.FREE_MONTHLY_COST_LIMIT_USD);
  return Number.isFinite(configuredLimit) && configuredLimit > 0
    ? configuredLimit
    : FREE_MONTHLY_COST_LIMIT_USD_DEFAULT;
};
