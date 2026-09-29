import { metrics } from "@opentelemetry/api";

const LARGE_RELAY_STREAM_BYTES = 1024 * 1024;

/** Record wire-subscription bytes with only bounded labels, so Trigger can
 * aggregate relay traffic across runs without searching individual logs. */
export function recordRelayReceivedBytes(
  operation: "command" | "file" | "pty" | "presence",
  source: "agent-long" | "chat-handler" | "presence-route" | "sandbox-manager",
  receivedBytes: number,
  unmatchedBytes = 0,
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
      });
    }
    if (unmatched > 0) {
      receivedBytesCounter.add(unmatched, {
        operation,
        source,
        correlation: "unmatched",
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

/** Log all large subscriptions and a deterministic 1/8 sample of the rest. */
export function relayTrafficSampleRate(
  id: string,
  bytes: number,
): number | null {
  if (bytes >= LARGE_RELAY_STREAM_BYTES) return 1;
  return Number.parseInt(id.replaceAll("-", "").slice(0, 1), 16) < 2 ? 8 : null;
}
