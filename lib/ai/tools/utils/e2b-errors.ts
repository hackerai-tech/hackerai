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

export type E2BErrorKind =
  | "authentication"
  | "not_found"
  | "template"
  | "invalid_argument"
  | "timeout"
  | "rate_limit"
  | "disk_space"
  | "command_exit"
  | "sandbox"
  | "other_error"
  | "non_error"
  | "unreadable";

/** Closed SDK identity for diagnostics; never read error names or messages. */
export function getE2BErrorKind(error: unknown): E2BErrorKind {
  try {
    if (error instanceof AuthenticationError) return "authentication";
    if (error instanceof NotFoundError) return "not_found";
    if (error instanceof TemplateError) return "template";
    if (error instanceof InvalidArgumentError) return "invalid_argument";
    if (error instanceof TimeoutError) return "timeout";
    if (error instanceof RateLimitError) return "rate_limit";
    if (error instanceof NotEnoughSpaceError) return "disk_space";
    if (error instanceof CommandExitError) return "command_exit";
    if (error instanceof SandboxError) return "sandbox";
    return error instanceof Error ? "other_error" : "non_error";
  } catch {
    return "unreadable";
  }
}

export type E2BConnectConflictMessageSignal =
  | "resuming"
  | "pausing"
  | "killing"
  | "snapshotting"
  | "already_running"
  | "guest_agent_unresponsive"
  | "busy"
  | "none"
  | "multiple"
  | "unreadable"
  | "oversized";

const MAX_CONNECT_CONFLICT_MESSAGE_LENGTH = 4096;

// Identifier characters bound each token, so longer words and identifier-like
// strings such as "unpausing" or "already-running" do not supply a signal.
const conflictToken = (pattern: string) =>
  new RegExp(`(?<![a-z0-9_-])${pattern}(?![a-z0-9_-])`, "i");

// Public E2B conflict phrases. They take precedence over standalone words
// because a phrase can mention another lifecycle word in passing.
const CONNECT_CONFLICT_PHRASES: ReadonlyArray<
  readonly [E2BConnectConflictMessageSignal, RegExp]
> = [
  ["killing", conflictToken(String.raw`being\s+killed`)],
  ["pausing", conflictToken(String.raw`being\s+paused`)],
  ["snapshotting", conflictToken(String.raw`being\s+snapshotted`)],
  [
    "snapshotting",
    conflictToken(String.raw`snapshot\s+is\s+currently\s+being\s+created`),
  ],
  ["already_running", conflictToken(String.raw`already\s+running`)],
  [
    "guest_agent_unresponsive",
    conflictToken(String.raw`guest\s+agent\s+(?:was\s+)?not\s+responding`),
  ],
  ["busy", conflictToken(String.raw`busy\s+with\s+another\s+operation`)],
];

const CONNECT_CONFLICT_WORDS: ReadonlyArray<
  readonly [E2BConnectConflictMessageSignal, RegExp]
> = (["resuming", "pausing", "killing", "snapshotting"] as const).map(
  (word) => [word, conflictToken(word)] as const,
);

/**
 * Closed projection of an original E2B 409 message for diagnostics. The signal
 * describes only the message text, never authoritative provider state or the
 * customer's cause. Matching stays in memory; text is never returned. Any other
 * error returns undefined without reading its message.
 */
export function getE2BConnectConflictMessageSignal(
  error: unknown,
): E2BConnectConflictMessageSignal | undefined {
  try {
    if (!(error instanceof SandboxError) || error.statusCode !== 409)
      return undefined;
  } catch {
    return undefined;
  }
  let message: unknown;
  try {
    message = (error as SandboxError).message;
  } catch {
    return "unreadable";
  }
  if (typeof message !== "string") return "unreadable";
  if (message.length > MAX_CONNECT_CONFLICT_MESSAGE_LENGTH) return "oversized";
  const text = message;
  const matching = (
    patterns: ReadonlyArray<readonly [E2BConnectConflictMessageSignal, RegExp]>,
  ) =>
    new Set(
      patterns
        .filter(([, pattern]) => pattern.test(text))
        .map(([signal]) => signal),
    );
  let signals = matching(CONNECT_CONFLICT_PHRASES);
  if (!signals.size) signals = matching(CONNECT_CONFLICT_WORDS);
  if (signals.size > 1) return "multiple";
  return [...signals][0] ?? "none";
}

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
  if (error instanceof TimeoutError) {
    // The E2B SDK embeds distinct phrases for different timeout causes:
    // - "sandbox timeout" → sandbox died/expired (permanent, won't recover)
    // - "requestTimeoutMs" → our request timed out (transient, worth retrying)
    // - "timeoutMs" → command execution exceeded its limit (transient)
    if (error.message.includes("sandbox timeout")) return "permanent";
    return "transient";
  }
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
    if (error.message.includes("sandbox timeout")) {
      return "Sandbox has expired.";
    }
    return "Sandbox operation timed out. The sandbox may be overloaded. Please try again.";
  }
  if (error instanceof NotFoundError) {
    return "Sandbox was not found or has expired.";
  }
  if (error instanceof InvalidArgumentError) {
    return "Invalid sandbox configuration. Please contact HackerAI support.";
  }

  return null;
}
