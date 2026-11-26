import { metrics } from "@opentelemetry/api";

/** Record wire-subscription bytes with only bounded labels, so Trigger can
 * aggregate relay traffic across runs without searching individual logs. */
export function recordRelayReceivedBytes(
  operation: "command" | "file" | "pty" | "presence",
  source: "agent-long" | "chat-handler" | "presence-route" | "sandbox-manager",
  receivedBytes: number,
  unmatchedBytes = 0,
  channel: "operation" | "connection" = "connection",
): void {
  if (!Number.isFinite(receivedBytes) || receivedBytes <= 0) return;
  const unmatched = Math.min(
    receivedBytes,
    Math.max(0, Number.isFinite(unmatchedBytes) ? unmatchedBytes : 0),
  );
  const matched = receivedBytes - unmatched;
  try {
    // The shared module can load before Trigger registers its meter provider.
    const receivedBytesCounter = metrics
      .getMeter("hackerai.local-relay")
      .createCounter("hackerai.local_relay.received_bytes", {
        description:
          "Estimated Centrifugo publication bytes received by server subscriptions",
        unit: "By",
      });
    if (matched > 0) {
      receivedBytesCounter.add(matched, {
        operation,
        source,
        correlation: "matched",
        channel,
      });
    }
    if (unmatched > 0) {
      receivedBytesCounter.add(unmatched, {
        operation,
        source,
        correlation: "unmatched",
        channel,
      });
    }
  } catch {
    // Telemetry must never interrupt a sandbox operation.
  }
}

/** Approximate received WebSocket payload size without copying large content. */
export function estimateRelayPayloadBytes(value: unknown): number {
  if (typeof value !== "object" || value === null) return 128;
  const payload = value as Record<string, unknown>;
  let bytes = 128;
  for (const key of ["data", "content", "stdin", "command"]) {
    if (typeof payload[key] === "string") {
      bytes += Buffer.byteLength(payload[key], "utf8");
    }
  }
  if (Array.isArray(payload.entries)) {
    bytes += estimateJsonBytes(payload.entries);
  }
  return bytes;
}

/** Visits enough values for a full large directory listing. */
const MAX_ESTIMATED_JSON_VALUES = 100_000;

/**
 * Approximate JSON size, iteratively and with bounded work, so a circular,
 * deeply nested or oversized value yields a lower-bound estimate instead of
 * throwing or stalling the relay subscription.
 */
function estimateJsonBytes(root: unknown): number {
  let bytes = 0;
  let remaining = MAX_ESTIMATED_JSON_VALUES;
  const seen = new WeakSet<object>();
  const pending: unknown[] = [root];
  try {
    while (pending.length > 0 && remaining-- > 0) {
      const value = pending.pop();
      if (typeof value === "string") {
        bytes += Buffer.byteLength(value, "utf8") + 2;
      } else if (typeof value === "number" || typeof value === "boolean") {
        bytes += String(value).length;
      } else if (value === null) {
        bytes += 4;
      } else if (typeof value === "object" && !seen.has(value)) {
        seen.add(value);
        if (Array.isArray(value)) {
          // Brackets and separators.
          bytes += 1 + Math.max(1, value.length);
          for (
            let index = 0;
            index < value.length && pending.length < remaining;
            index++
          ) {
            pending.push(value[index]);
          }
        } else {
          const record = value as Record<string, unknown>;
          const keys = Object.keys(record);
          bytes += 1 + Math.max(1, keys.length);
          for (const key of keys) {
            if (pending.length >= remaining) break;
            // Quoted key and colon.
            bytes += Buffer.byteLength(key, "utf8") + 3;
            pending.push(record[key]);
          }
        }
      }
    }
  } catch {
    // An accessor that throws ends the estimate with what was counted.
  }
  return bytes;
}
