type Properties = Record<string, unknown>;
type RelayEvent =
  "desktop_bridge_relay_error" | "desktop_bridge_relay_state_changed";
type Bucket = {
  event: RelayEvent;
  properties: Properties;
  suppressed: number;
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
    ) => unknown,
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
      bucket.suppressed += 1;
      bucket.lastSeen = now;
      bucket.properties = properties;
      return;
    }
    if (this.buckets.size >= MAX_SIGNATURES) this.flush();
    if (this.buckets.size === 0) this.windowStartedAt = now;
    this.buckets.set(key, {
      event,
      properties,
      suppressed: 0,
      firstSeen: now,
      lastSeen: now,
    });
    this.capture(event, {
      ...properties,
      telemetry_version: 1,
      telemetry_occurrences: 1,
      telemetry_summary: false,
    });
  }

  flush(): void {
    for (const bucket of this.buckets.values()) {
      if (bucket.suppressed === 0) continue;
      this.capture(bucket.event, {
        ...bucket.properties,
        telemetry_version: 1,
        telemetry_occurrences: bucket.suppressed,
        telemetry_summary: true,
        telemetry_window_started_at: new Date(bucket.firstSeen).toISOString(),
        telemetry_last_seen_at: new Date(bucket.lastSeen).toISOString(),
      });
    }
    this.buckets.clear();
  }
}
