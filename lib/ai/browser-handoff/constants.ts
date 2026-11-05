// Cover the six-hour Agent wall-clock limit plus cleanup grace.
// Shared with backend registration and the detached sandbox watchdog.
export const BROWSER_SESSION_MAX_LIFETIME_MS = (6 * 60 + 5) * 60 * 1000;
