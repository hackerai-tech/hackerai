import { ChatSDKError } from "@/lib/errors";

const OPERATIONAL_RATE_LIMIT_CAUSE_PATTERNS = [
  /rate limiting service .*not configured/i,
  /rate limiting service unavailable/i,
  /extra usage billing is temporarily unavailable/i,
];

const HANDLED_USER_RATE_LIMIT_CAP_REASONS = new Set([
  "free_concurrency",
  "daily_requests_exhausted",
  "free_monthly_exhausted",
  "monthly_exhausted",
  "extra_usage_cap",
  "team_member_cap",
  "team_member_disabled",
  "team_pool_disabled",
  "auto_reload_failed",
  "paid_daily_free_allowance_exhausted",
  "paid_daily_free_allowance_cut_off",
]);

/**
 * Distinguish expected user quota exhaustion from rate-limit infrastructure
 * failures that still require operator attention.
 */
export const isHandledUserRateLimitError = (
  error: unknown,
): error is ChatSDKError => {
  if (!(error instanceof ChatSDKError)) return false;
  if (error.type !== "rate_limit" || error.surface !== "chat") return false;

  const cause = typeof error.cause === "string" ? error.cause : error.message;
  if (
    OPERATIONAL_RATE_LIMIT_CAUSE_PATTERNS.some((pattern) => pattern.test(cause))
  ) {
    return false;
  }

  const capReason = error.metadata?.capReason;
  return (
    typeof capReason === "string" &&
    HANDLED_USER_RATE_LIMIT_CAP_REASONS.has(capReason)
  );
};
