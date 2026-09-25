type LogLevel = "info" | "warn" | "error";
type OtlpValue =
  { stringValue: string } | { doubleValue: number } | { boolValue: boolean };

type OtlpAttribute = {
  key: string;
  value: OtlpValue;
};

type QueuedLogRecord = {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: OtlpAttribute[];
};

type EmitLogOptions = {
  level: LogLevel;
  event: string;
  body: string;
  attributes?: Record<string, unknown>;
};

const LOG_ATTRIBUTE_VALUE_MAX_LENGTH = 2_000;
const LOG_ATTRIBUTE_COUNT_LIMIT = 80;
const LOG_BATCH_SIZE = 50;
const LOG_QUEUE_LIMIT = 1_000;
const LOG_FLUSH_INTERVAL_MS = 2_000;
const LOG_EXPORT_TIMEOUT_MS = 5_000;
const DEFAULT_SERVICE_NAME = "hackerai-web";
const POSTHOG_CORRELATION_KEYS = new Set(["posthogDistinctId", "sessionId"]);

let pendingLogs: QueuedLogRecord[] = [];
let flushPromise: Promise<void> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function getEnvironment(): string {
  return (
    process.env.VERCEL_ENV ??
    process.env.NODE_ENV ??
    process.env.ENVIRONMENT ??
    "unknown"
  );
}

function getServiceName(): string {
  return process.env.POSTHOG_LOG_SERVICE_NAME ?? DEFAULT_SERVICE_NAME;
}

function truncate(value: string, maxLength = LOG_ATTRIBUTE_VALUE_MAX_LENGTH) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function getPostHogToken(): string | undefined {
  return (
    process.env.POSTHOG_PROJECT_TOKEN ??
    process.env.NEXT_PUBLIC_POSTHOG_KEY ??
    undefined
  );
}

function getPostHogIngestHost(): string {
  const rawHost =
    process.env.POSTHOG_LOG_HOST ??
    process.env.NEXT_PUBLIC_POSTHOG_HOST ??
    "https://us.i.posthog.com";
  const host = rawHost.replace(/\/+$/, "");

  if (host === "https://app.posthog.com" || host === "https://us.posthog.com") {
    return "https://us.i.posthog.com";
  }
  if (host === "https://eu.posthog.com") {
    return "https://eu.i.posthog.com";
  }
  return host;
}

function severityNumberFor(level: LogLevel): number {
  if (level === "error") return 17;
  if (level === "warn") return 13;
  return 9;
}

function normalizeAttributeKey(key: string): string {
  if (POSTHOG_CORRELATION_KEYS.has(key)) {
    return key;
  }

  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^\w.]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

// Build a bounded snapshot before encoding. Never invoke getters, toJSON, or
// user-defined string coercion while preparing best-effort diagnostics.
function stringifyUnknown(value: unknown): string {
  let remainingCharacters = LOG_ATTRIBUTE_VALUE_MAX_LENGTH;
  let remainingNodes = 100;
  const seen = new WeakSet<object>();
  const text = (value: string) => {
    const result = value.slice(0, remainingCharacters);
    remainingCharacters -= result.length;
    return result;
  };
  const visit = (input: unknown, depth: number): unknown => {
    if (remainingNodes-- <= 0 || remainingCharacters <= 0) return "[truncated]";
    if (typeof input === "string") return text(input);
    if (
      input === null ||
      typeof input === "boolean" ||
      typeof input === "number"
    )
      return input;
    if (typeof input !== "object") return `[${typeof input}]`;
    if (depth >= 4) return "[depth limit]";
    if (seen.has(input)) return "[circular]";
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        const result: unknown[] = [];
        const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
        if (typeof length !== "number") return "[unavailable]";
        for (let index = 0; index < Math.min(length, 40); index += 1) {
          if (remainingNodes <= 0 || remainingCharacters <= 0) {
            result.push("[truncated]");
            break;
          }
          const descriptor = Object.getOwnPropertyDescriptor(
            input,
            String(index),
          );
          result.push(
            descriptor && "value" in descriptor
              ? visit(descriptor.value, depth + 1)
              : "[accessor or empty]",
          );
        }
        if (length > 40) result.push("[truncated]");
        return result;
      }
      const result: Record<string, unknown> = Object.create(null);
      let count = 0;
      for (const key in input) {
        if (++count > 40 || remainingNodes <= 0 || remainingCharacters <= 0) {
          result["[truncated]"] = true;
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor?.enumerable) continue;
        result[text(key)] =
          "value" in descriptor
            ? visit(descriptor.value, depth + 1)
            : "[accessor]";
      }
      return result;
    } catch {
      return "[unavailable]";
    }
  };
  try {
    return truncate(JSON.stringify(visit(value, 0)));
  } catch {
    return "[unavailable]";
  }
}

function toOtlpValue(value: unknown): OtlpValue | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "string") {
    return { stringValue: truncate(value) };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return { doubleValue: value };
  }

  return { stringValue: truncate(stringifyUnknown(value)) };
}

function toOtlpAttributes(
  event: string,
  attributes: Record<string, unknown> = {},
): OtlpAttribute[] {
  const result: OtlpAttribute[] = [];
  const usedKeys = new Set<string>();
  const append = (key: string, value: unknown) => {
    const normalizedKey = normalizeAttributeKey(key.slice(0, 128)).slice(
      0,
      128,
    );
    if (!normalizedKey || usedKeys.has(normalizedKey)) return;
    const otlpValue = toOtlpValue(value);
    if (!otlpValue) return;
    usedKeys.add(normalizedKey);
    result.push({ key: normalizedKey, value: otlpValue });
  };
  const read = (key: string) => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(attributes, key);
      return descriptor?.enumerable && "value" in descriptor
        ? descriptor.value
        : undefined;
    } catch {
      return undefined;
    }
  };
  append("service", read("service") ?? getServiceName());
  append("environment", read("environment") ?? getEnvironment());
  append("runtime", read("runtime") ?? "node");
  append("event", event);
  for (const key of POSTHOG_CORRELATION_KEYS) append(key, read(key));
  let inspected = 0;
  try {
    for (const key in attributes) {
      // Bound inspected keys as well as emitted values, including empty fields.
      if (result.length >= LOG_ATTRIBUTE_COUNT_LIMIT || inspected++ >= 160)
        break;
      append(key, read(key));
    }
  } catch {
    // A diagnostic object must not make its caller fail.
  }
  return result;
}

function nowUnixNano(): string {
  return `${BigInt(Date.now()) * BigInt(1_000_000)}`;
}

function buildOtlpPayload(logs: QueuedLogRecord[]) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: getServiceName() } },
            {
              key: "deployment.environment",
              value: { stringValue: getEnvironment() },
            },
            {
              key: "service.version",
              value: {
                stringValue: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
              },
            },
          ],
        },
        scopeLogs: [
          {
            scope: { name: getServiceName() },
            logRecords: logs,
          },
        ],
      },
    ],
  };
}

function scheduleFlush(delayMs: number): void {
  if (flushTimer) {
    if (delayMs > 0) return;
    clearTimeout(flushTimer);
  }

  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPostHogLogs().catch(() => {
      // best-effort telemetry
    });
  }, delayMs);
  flushTimer.unref?.();
}

export function registerPostHogLogProvider() {
  // Kept as an explicit hook for Next instrumentation; the raw OTLP sender is
  // initialized lazily so builds and edge runtimes do not need log setup work.
}

export function emitPostHogLog({
  level,
  event,
  body,
  attributes,
}: EmitLogOptions): boolean {
  if (!getPostHogToken()) return false;

  pendingLogs.push({
    timeUnixNano: nowUnixNano(),
    severityNumber: severityNumberFor(level),
    severityText: level.toUpperCase(),
    body: { stringValue: truncate(body) },
    attributes: toOtlpAttributes(event, attributes),
  });

  if (pendingLogs.length > LOG_QUEUE_LIMIT) {
    pendingLogs.splice(0, pendingLogs.length - LOG_QUEUE_LIMIT);
  }
  scheduleFlush(
    pendingLogs.length >= LOG_BATCH_SIZE ? 0 : LOG_FLUSH_INTERVAL_MS,
  );

  return true;
}

async function flushBatch(logs: QueuedLogRecord[]): Promise<void> {
  const token = getPostHogToken();
  if (!token || logs.length === 0) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOG_EXPORT_TIMEOUT_MS);
  timeout.unref?.();

  try {
    const response = await fetch(`${getPostHogIngestHost()}/i/v1/logs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify(buildOtlpPayload(logs)),
    });

    if (!response.ok) {
      throw new Error(`PostHog log export failed: ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function flushPostHogLogs(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  if (flushPromise) {
    await flushPromise;
  }

  const logsToFlush = pendingLogs.slice(0, LOG_BATCH_SIZE);
  if (logsToFlush.length === 0) return;

  flushPromise = (async () => {
    await flushBatch(logsToFlush);
    const flushedLogs = new Set(logsToFlush);
    pendingLogs = pendingLogs.filter((log) => !flushedLogs.has(log));
  })().finally(() => {
    flushPromise = null;
  });

  try {
    await flushPromise;
  } catch (error) {
    if (pendingLogs.length > 0) {
      scheduleFlush(LOG_FLUSH_INTERVAL_MS);
    }
    throw error;
  }

  if (pendingLogs.length > 0) {
    await flushPostHogLogs();
  }
}
