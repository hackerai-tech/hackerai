const LARGE_RELAY_STREAM_BYTES = 1024 * 1024;

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
  return bytes;
}

/** Log all large subscriptions and a deterministic 1/256 sample of the rest. */
export function relayTrafficSampleRate(
  id: string,
  bytes: number,
): number | null {
  if (bytes >= LARGE_RELAY_STREAM_BYTES) return 1;
  return Number.parseInt(id.replaceAll("-", "").slice(0, 2), 16) === 0
    ? 256
    : null;
}
