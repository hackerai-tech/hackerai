import { createRedisClient } from "@/lib/rate-limit/redis";
import { phLogger } from "@/lib/posthog/server";

type GroupedSpikeAlertOptions = {
  spikeKey: string;
  sourceEvent: string;
  threshold?: number;
  windowMs?: number;
  cooldownMs?: number;
  attributes?: Record<string, unknown>;
};

export const GROUPED_SPIKE_ALERT_WINDOW_MS = 5 * 60 * 1000;
export const GROUPED_SPIKE_ALERT_THRESHOLD = 5;
export const GROUPED_SPIKE_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

let counterFailureLogged = false;

const normalizeKey = (value: string): string =>
  value.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 160);

/**
 * Best-effort distributed aggregation for noisy operational failures.
 * Individual failures remain queryable as warning logs; one stable exception
 * is emitted only after the shared threshold is crossed, then cooled down.
 */
export async function recordGroupedSpikeAlert({
  spikeKey,
  sourceEvent,
  threshold = GROUPED_SPIKE_ALERT_THRESHOLD,
  windowMs = GROUPED_SPIKE_ALERT_WINDOW_MS,
  cooldownMs = GROUPED_SPIKE_ALERT_COOLDOWN_MS,
  attributes = {},
}: GroupedSpikeAlertOptions): Promise<void> {
  const redis = createRedisClient();
  if (!redis) return;

  const now = Date.now();
  const bucketStartedAt = Math.floor(now / windowMs) * windowMs;
  const normalizedSpikeKey = normalizeKey(spikeKey);
  const counterKey = `observability:spike:${normalizedSpikeKey}:${bucketStartedAt}`;
  const cooldownKey = `observability:spike-alert:${normalizedSpikeKey}`;
  const counterTtlSeconds = Math.max(1, Math.ceil((windowMs * 2) / 1000));
  const cooldownSeconds = Math.max(1, Math.ceil(cooldownMs / 1000));

  try {
    const count = Number(await redis.incr(counterKey));
    // Refresh TTL on every write so a transient expiry failure cannot leave a
    // permanent operational counter behind.
    await redis.expire(counterKey, counterTtlSeconds);
    if (count < threshold) return;

    const claimed = await redis.set(cooldownKey, String(bucketStartedAt), {
      nx: true,
      ex: cooldownSeconds,
    });
    if (!claimed) return;

    phLogger.error("Grouped operational error spike detected", {
      ...attributes,
      event: "grouped_operational_error_spike_detected",
      spike_key: normalizedSpikeKey,
      source_event: sourceEvent,
      occurrence_count: count,
      threshold,
      window_ms: windowMs,
      cooldown_ms: cooldownMs,
      window_started_at: new Date(bucketStartedAt).toISOString(),
    });
  } catch (error) {
    if (counterFailureLogged) return;
    counterFailureLogged = true;
    phLogger.warn("Grouped spike counter unavailable", {
      event: "grouped_spike_counter_unavailable",
      request_id: attributes.request_id ?? null,
      spike_key: normalizedSpikeKey,
      source_event: sourceEvent,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export function resetGroupedSpikeAlertStateForTests(): void {
  counterFailureLogged = false;
}
