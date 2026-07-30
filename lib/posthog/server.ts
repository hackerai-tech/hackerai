import PostHogClient from "@/app/posthog";
import { emitPostHogLog, flushPostHogLogs } from "@/lib/posthog/logs";
import { redactSensitiveErrorMessage } from "@/lib/utils/error-redaction";
import type { PostHog } from "posthog-node";

let cachedClient: PostHog | null | undefined;

function getClient(): PostHog | null {
  if (cachedClient === undefined) {
    cachedClient = PostHogClient();
  }
  return cachedClient;
}

type LogFields = Record<string, unknown> & {
  userId?: string;
  error?: unknown;
};

type EventFields = Record<string, unknown> & {
  userId?: string;
  eventUuid?: string;
  $set?: Record<string, unknown>;
};

const TELEMETRY_STRING_MAX_LENGTH = 2_000;

function distinctIdFor(userId: unknown): string {
  return typeof userId === "string" && userId.length > 0 ? userId : "system";
}

function getEnvironment(): string {
  return (
    process.env.VERCEL_ENV ??
    process.env.NODE_ENV ??
    process.env.ENVIRONMENT ??
    "unknown"
  );
}

function getServiceName(): string {
  return process.env.POSTHOG_LOG_SERVICE_NAME ?? "hackerai-web";
}

function truncate(value: string, maxLength = TELEMETRY_STRING_MAX_LENGTH) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function eventNameFor(message: string, fallback = "application_log"): string {
  const normalized = message
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return normalized.length > 0 ? normalized.slice(0, 100) : fallback;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: truncate(redactSensitiveErrorMessage(error.message)),
      ...(error.stack && {
        error_stack: truncate(redactSensitiveErrorMessage(error.stack), 4_000),
      }),
      ...("cause" in error &&
        (error as { cause?: unknown }).cause !== undefined && {
          error_cause:
            (error as { cause?: unknown }).cause instanceof Error
              ? truncate(
                  redactSensitiveErrorMessage(
                    (error as { cause: Error }).cause.message,
                  ),
                )
              : truncate(
                  redactSensitiveErrorMessage(
                    String((error as { cause?: unknown }).cause),
                  ),
                ),
        }),
    };
  }

  if (error === undefined) return {};

  return {
    error_name: "UnknownError",
    error_message: truncate(
      redactSensitiveErrorMessage(stringifyUnknown(error)),
    ),
  };
}

function sanitizeExceptionForCapture(error: Error): Error {
  const serialized = serializeError(error);
  const message =
    typeof serialized.error_message === "string"
      ? serialized.error_message
      : "Unknown error";
  const sanitized = new Error(message);
  sanitized.name =
    typeof serialized.error_name === "string"
      ? serialized.error_name
      : error.name;
  if (typeof serialized.error_stack === "string") {
    sanitized.stack = serialized.error_stack;
  }
  // PostHog traverses Error.cause. Keep the diagnostic fields above, but do
  // not retain a raw cause that could reintroduce a presigned URL or object key.
  return sanitized;
}

function sanitizeErrorForConsole(error: unknown): unknown {
  if (error instanceof Error) {
    const serialized = [
      error.message,
      error.stack ?? "",
      stringifyUnknown(error),
    ].join("\n");
    return redactSensitiveErrorMessage(serialized) === serialized
      ? error
      : sanitizeExceptionForCapture(error);
  }
  if (error === undefined) return undefined;
  return redactSensitiveErrorMessage(stringifyUnknown(error));
}

function sanitizeFieldsForConsole(fields: LogFields): LogFields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      key === "error"
        ? sanitizeErrorForConsole(value)
        : typeof value === "string"
          ? redactSensitiveErrorMessage(value)
          : value,
    ]),
  );
}

function commonLogFields({
  level,
  event,
  message,
  userId,
}: {
  level: "info" | "warn" | "error";
  event: string;
  message: string;
  userId?: string;
}) {
  return {
    level,
    event,
    message,
    service: getServiceName(),
    environment: getEnvironment(),
    ...(userId && { posthogDistinctId: userId, user_id: userId }),
    timestamp: new Date().toISOString(),
  };
}

function emitStructuredLog(
  level: "info" | "warn" | "error",
  message: string,
  fields: LogFields,
): boolean {
  const event =
    typeof fields.event === "string" && fields.event.length > 0
      ? fields.event
      : eventNameFor(message);
  const { userId, error, ...rest } = fields;

  try {
    return emitPostHogLog({
      level,
      event,
      body: message,
      attributes: {
        ...rest,
        ...commonLogFields({ level, event, message, userId }),
        ...serializeError(error),
      },
    });
  } catch {
    return false;
  }
}

export const phLogger = {
  error(message: string, fields: LogFields = {}) {
    const redactedMessage = redactSensitiveErrorMessage(message);
    const wroteLog = emitStructuredLog("error", redactedMessage, fields);
    const safeFields = sanitizeFieldsForConsole(fields);
    const client = getClient();
    if (!client) {
      if (!wroteLog) console.error(redactedMessage, safeFields);
      return;
    }
    try {
      const { userId, error, ...rest } = fields;
      const exception = sanitizeExceptionForCapture(
        error instanceof Error ? error : new Error(redactedMessage),
      );
      const event =
        typeof fields.event === "string" && fields.event.length > 0
          ? fields.event
          : eventNameFor(redactedMessage);
      client.captureException(exception, distinctIdFor(userId), {
        ...rest,
        ...commonLogFields({
          level: "error",
          event,
          message: redactedMessage,
          userId,
        }),
        ...serializeError(exception),
        message: redactedMessage,
      });
    } catch (telemetryError) {
      console.error(redactedMessage, {
        ...safeFields,
        telemetryError: sanitizeErrorForConsole(telemetryError),
      });
    }
  },

  warn(message: string, fields: LogFields = {}) {
    const wroteLog = emitStructuredLog("warn", message, fields);
    if (!wroteLog) console.warn(message, fields);
  },

  info(message: string, fields: LogFields = {}) {
    const wroteLog = emitStructuredLog("info", message, fields);
    if (!wroteLog) console.log(message, fields);
  },

  event(name: string, fields: EventFields = {}) {
    const client = getClient();
    if (!client) return;
    try {
      const { userId, eventUuid, $set, ...rest } = fields;
      client.capture({
        distinctId: distinctIdFor(userId),
        event: name,
        ...(eventUuid && { uuid: eventUuid }),
        properties: { ...rest, ...($set && { $set }) },
      });
    } catch {
      // best-effort
    }
  },

  async flush(): Promise<void> {
    await Promise.allSettled([getClient()?.flush(), flushPostHogLogs()]);
  },
};
