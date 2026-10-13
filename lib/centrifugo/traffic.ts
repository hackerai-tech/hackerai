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
    bytes += Buffer.byteLength(JSON.stringify(payload.entries), "utf8");
  }
  return bytes;
}
