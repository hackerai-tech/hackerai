import {
  SandboxError,
  TimeoutError,
  NotFoundError,
  AuthenticationError,
  NotEnoughSpaceError,
  RateLimitError,
  TemplateError,
  InvalidArgumentError,
  CommandExitError,
} from "@e2b/code-interpreter";

export {
  SandboxError,
  TimeoutError,
  NotFoundError,
  AuthenticationError,
  NotEnoughSpaceError,
  RateLimitError,
  TemplateError,
  InvalidArgumentError,
  CommandExitError,
};

/**
 * E2B error classification categories.
 * - "permanent": never retry (auth, template, invalid args, sandbox gone)
 * - "transient": retry with standard backoff (timeouts, generic sandbox errors)
 * - "rate_limit": retry with extended backoff
 * - "disk_space": actionable — tell user to free space
 * - "command_failure": command ran but returned non-zero exit (don't retry)
 * - "unknown": not a recognized E2B error
 */
export type E2BErrorCategory =
  | "permanent"
  | "transient"
  | "rate_limit"
  | "disk_space"
  | "command_failure"
  | "unknown";

/**
 * Classify an error into an E2B error category using instanceof checks
 * against the SDK's error class hierarchy.
 */
export function classifyE2BError(error: unknown): E2BErrorCategory {
  if (!(error instanceof Error)) return "unknown";

  if (error instanceof CommandExitError) return "command_failure";
  if (error instanceof AuthenticationError) return "permanent";
  if (error instanceof TemplateError) return "permanent";
  if (error instanceof InvalidArgumentError) return "permanent";
  if (error instanceof RateLimitError) return "rate_limit";
  if (error instanceof NotEnoughSpaceError) return "disk_space";
  if (error instanceof NotFoundError) return "permanent";
  if (error instanceof TimeoutError) return "transient";
  if (error instanceof SandboxError) return "transient";

  // String-based fallback for edge cases
  if (error.message.includes("not running anymore")) return "permanent";
  if (error.message.includes("Sandbox not found")) return "permanent";

  return "unknown";
}

/**
 * Check if an error is permanent and should not be retried.
 * Drop-in replacement for existing ad-hoc isPermanentError functions.
 */
export function isE2BPermanentError(error: unknown): boolean {
  const category = classifyE2BError(error);
  return category === "permanent" || category === "command_failure";
}

/**
 * Check if an error is a rate limit that requires extended backoff.
 */
export function isE2BRateLimitError(error: unknown): boolean {
  return error instanceof RateLimitError;
}

/**
 * Generate a user-friendly error message based on the E2B error type.
 * Returns null if the error is not a recognized E2B error.
 */
export function getUserFacingE2BErrorMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;

  if (error instanceof AuthenticationError) {
    return "Sandbox authentication failed. The E2B API key may be invalid or expired. Please contact HackerAI support.";
  }
  if (error instanceof RateLimitError) {
    return "Sandbox API rate limit exceeded. Please wait a moment and try again.";
  }
  if (error instanceof NotEnoughSpaceError) {
    return "Sandbox disk space is full. Try removing unnecessary files or deleting the sandbox in Settings > Data Controls.";
  }
  if (error instanceof TemplateError) {
    return "Sandbox template is incompatible. Please contact HackerAI support.";
  }
  if (error instanceof TimeoutError) {
    return "Sandbox operation timed out. The sandbox may be overloaded. Please try again.";
  }
  if (error instanceof NotFoundError) {
    return "Sandbox was not found or has expired. A new sandbox will be created automatically.";
  }
  if (error instanceof InvalidArgumentError) {
    return "Invalid sandbox configuration. Please contact HackerAI support.";
  }

  return null;
}
