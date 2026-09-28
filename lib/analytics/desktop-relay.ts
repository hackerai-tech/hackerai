type Properties = Record<string, unknown>;
type RelayEvent =
  "desktop_bridge_relay_error" | "desktop_bridge_relay_state_changed";
type Bucket = {
  event: RelayEvent;
  properties: Properties;
  pending: number;
  firstCaptured: boolean;
  firstSeen: number;
  lastSeen: number;
};

const WINDOW_MS = 5 * 60 * 1000;
const MAX_SIGNATURES = 32;

/** Keep first occurrences immediately; summarize repeated relay callbacks.
 * Console diagnostics and connection/recovery behavior remain independent.
 * Sum telemetry_occurrences (default 1 for old events), rather than count().
 */
export class DesktopRelayTelemetry {
  private buckets = new Map<string, Bucket>();
  private windowStartedAt = 0;

  constructor(
    private readonly capture: (
      event: RelayEvent,
      properties: Properties,
    ) => boolean,
  ) {}

  record(event: RelayEvent, properties: Properties): void {
    const now = Date.now();
    if (now - this.windowStartedAt >= WINDOW_MS) this.flush();
    // Do not key on free-form error messages or ever-growing retry counters.
    const key = JSON.stringify([
      event,
      properties.state,
      properties.source,
      properties.errorType,
      properties.code,
      properties.transport,
      properties.recovered,
    ]);
    const bucket = this.buckets.get(key);
    if (bucket) {
      bucket.pending += 1;
      bucket.lastSeen = now;
      bucket.properties = properties;
      if (!bucket.firstCaptured) this.capturePending(bucket);
      return;
    }
    if (this.buckets.size >= MAX_SIGNATURES) this.flush();
    if (this.buckets.size >= MAX_SIGNATURES) {
      // Keep this best-effort buffer bounded even while capture is unavailable.
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    if (this.buckets.size === 0) this.windowStartedAt = now;
    const nextBucket: Bucket = {
      event,
      properties,
      pending: 1,
      firstCaptured: false,
      firstSeen: now,
      lastSeen: now,
    };
    this.buckets.set(key, nextBucket);
    this.capturePending(nextBucket);
  }

  private capturePending(bucket: Bucket): boolean {
    try {
      if (
        !this.capture(bucket.event, {
          ...bucket.properties,
          telemetry_version: 1,
          telemetry_occurrences: bucket.pending,
          telemetry_summary: bucket.firstCaptured,
          telemetry_window_started_at: new Date(bucket.firstSeen).toISOString(),
          telemetry_last_seen_at: new Date(bucket.lastSeen).toISOString(),
        })
      )
        return false;
    } catch {
      return false;
    }
    bucket.pending = 0;
    bucket.firstCaptured = true;
    return true;
  }

  flush(): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.pending === 0 || this.capturePending(bucket)) {
        this.buckets.delete(key);
      }
    }
  }
}
