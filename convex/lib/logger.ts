/**
 * Convex Structured Logger
 *
 * Simple structured logging for Convex functions.
 * Logs appear in the Convex dashboard.
 */

type LogLevel = "info" | "warn" | "error";

interface LogEvent {
  level: LogLevel;
  event: string;
  timestamp: string;
  [key: string]: unknown;
}

function log(
  level: LogLevel,
  event: string,
  data: Record<string, unknown> = {},
) {
  const logEvent: LogEvent = {
    level,
    event,
    timestamp: new Date().toISOString(),
    ...data,
  };

  if (level === "error") {
    console.error(JSON.stringify(logEvent));
  } else if (level === "warn") {
    console.warn(JSON.stringify(logEvent));
  } else {
    console.log(JSON.stringify(logEvent));
  }
}

export const convexLogger = {
  info: (event: string, data?: Record<string, unknown>) =>
    log("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) =>
    log("warn", event, data),
  error: (event: string, data?: Record<string, unknown>) =>
    log("error", event, data),
};
