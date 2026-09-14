import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { z } from "zod";
import { getTriggerHealthConfig, healthCacheKey } from "./config";
import { freshReport, getReport, type HealthResult } from "./trigger-report";
import { runProbe, type ProbeResult } from "./trigger-probe";

const MAX_PROBE_AGE_MS = 180_000;
const statusSchema = z.enum(["healthy", "degraded", "failing", "unknown"]);
const timestamp = z.iso.datetime({ offset: true });
const snapshotSchema = z.object({
  probe: z.object({
    status: z.enum(["healthy", "failing", "unknown"]),
    checkedAt: timestamp,
    error: z.string().optional(),
  }),
  report: z
    .object({
      status: statusSchema,
      generatedAt: timestamp.optional(),
      dimensions: z
        .object({
          flow: statusSchema,
          execution: statusSchema,
          liveness: statusSchema,
        })
        .optional(),
      error: z.string().optional(),
      sourceStatus: z.number().int().optional(),
    })
    .refine(
      (report) => report.status === "unknown" || Boolean(report.generatedAt),
    ),
  reportAttemptAt: timestamp,
  reportRefreshError: z.string().optional(),
});
type Snapshot = z.infer<typeof snapshotSchema>;

function store() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return undefined;
  return new Redis({
    url,
    token,
    retry: false,
    // A factory gives every Redis command its own timeout.
    signal: () => AbortSignal.timeout(3_000),
  });
}

function unknownProbe(error: string): ProbeResult {
  return { status: "unknown", checkedAt: new Date().toISOString(), error };
}

export async function readTriggerHealth(): Promise<{
  probe: ProbeResult;
  report: HealthResult;
  reportAttemptAt?: string;
  reportRefreshError?: string;
}> {
  const unavailable = (error: string) => ({
    probe: unknownProbe(error),
    report: { status: "unknown" as const, error },
  });
  const config = getTriggerHealthConfig();
  const redis = store();
  if (!config || !redis) return unavailable("health_monitor_not_configured");
  try {
    const parsed = snapshotSchema.safeParse(
      await redis.get(healthCacheKey(config)),
    );
    if (!parsed.success) return unavailable("health_data_unavailable");
    const snapshot = parsed.data;
    const age = Date.now() - Date.parse(snapshot.probe.checkedAt);
    return {
      ...snapshot,
      probe:
        age > MAX_PROBE_AGE_MS || age < -30_000
          ? { ...snapshot.probe, status: "unknown", error: "health_data_stale" }
          : snapshot.probe,
      report: freshReport(snapshot.report),
    };
  } catch {
    return unavailable("health_store_unavailable");
  }
}

// Keep the lease until it expires to bound authenticated repeated calls too.
// Fencing prevents a stalled collector from overwriting a newer result.
const PUBLISH = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', 600)
return 1
`;

export async function refreshTriggerHealth(): Promise<{
  ok: boolean;
  skipped?: boolean;
  error?: string;
}> {
  const config = getTriggerHealthConfig();
  const redis = store();
  if (!config || !redis)
    return { ok: false, error: "health_monitor_not_configured" };
  const key = healthCacheKey(config);
  const owner = randomUUID();
  try {
    // 55-second route budget, 60-second lease, one collector per target.
    const acquired = await redis.set(`${key}:lease`, owner, {
      nx: true,
      ex: 60,
    });
    if (!acquired) return { ok: true, skipped: true };
    const previous = snapshotSchema.safeParse(await redis.get(key));
    const reportAttemptAt = new Date().toISOString();
    const [probe, report] = await Promise.all([
      runProbe(config),
      getReport(config),
    ]);
    // Only a transient retrieval failure may reuse prior evidence. An explicit
    // failing/unknown report or denied credentials takes effect immediately.
    const transient =
      report.error === "trigger_report_timeout" ||
      report.error === "trigger_report_fetch_failed" ||
      (report.error === "trigger_report_unavailable" &&
        (report.sourceStatus === 429 || (report.sourceStatus ?? 0) >= 500));
    const oldReport = previous.success
      ? freshReport(previous.data.report)
      : undefined;
    const retain = transient && oldReport?.generatedAt && !oldReport.error;
    const snapshot: Snapshot = {
      probe,
      report: retain ? oldReport : report,
      reportAttemptAt,
      ...(retain ? { reportRefreshError: report.error } : {}),
    };
    const published = await redis.eval<unknown[], number>(
      PUBLISH,
      [`${key}:lease`, key],
      [owner, JSON.stringify(snapshot)],
    );
    console.info(
      JSON.stringify({
        event: "trigger_health_collected",
        probe_status: probe.status,
        probe_error: probe.error,
        report_status: snapshot.report.status,
        report_error: report.error,
        published: published === 1,
      }),
    );
    return published === 1
      ? { ok: true }
      : { ok: false, error: "health_collection_lease_expired" };
  } catch {
    // Redis errors may embed request details or credentials.
    console.warn(
      JSON.stringify({
        event: "trigger_health_collection_failed",
        category: "store_unavailable",
      }),
    );
    return { ok: false, error: "health_store_unavailable" };
  }
}
