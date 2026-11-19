// Cover the six-hour Agent wall-clock limit plus cleanup grace.
// Shared with backend registration and the detached sandbox watchdog.
export const BROWSER_SESSION_MAX_LIFETIME_MS = (6 * 60 + 5) * 60 * 1000;

/** A resume claim that has not finished in this window needs the user again. */
export const BROWSER_HANDOFF_RESUME_GRACE_MS = 30_000;

/**
 * A parent run held by an unclaimed or recovered handoff stops after this long
 * without a renewed human grant. Progress is saved; only the user resumes it.
 */
export const BROWSER_HANDOFF_ABANDON_AFTER_MS = 30 * 60 * 1000;

/** Persisted chat/message finish reason for an abandoned parent handoff. */
export const BROWSER_HANDOFF_ABANDONED_FINISH_REASON =
  "browser-handoff-abandoned";
