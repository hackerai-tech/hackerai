import { ChatSDKError } from "@/lib/errors";

const OPERATIONAL_RATE_LIMIT_CAUSE_PATTERNS = [
  /rate limiting service .*not configured/i,
  /rate limiting service unavailable/i,
  /extra usage billing is temporarily unavailable/i,
];

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
  return !OPERATIONAL_RATE_LIMIT_CAUSE_PATTERNS.some((pattern) =>
    pattern.test(cause),
  );
};
