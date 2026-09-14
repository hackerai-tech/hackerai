import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

const REPORT_PATH = "/api/v1/reports/health?period=1h&format=json";
const FETCH_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 60_000;
const MAX_REPORT_AGE_MS = 120_000;
const DIMENSIONS = ["flow", "execution", "liveness"] as const;
const severitySchema = z.enum(["ok", "warn", "crit"]);

// Validate the consumed fields of Trigger's ReportViewModel, ignoring private
// metrics, attribution, links, and facts that this public endpoint doesn't need.
// Contract: https://trigger.dev/docs/reports (format=json).
const reportSchema = z.object({
  title: z.literal("health"),
  generatedAt: z.iso.datetime({ offset: true }),
  windowMinutes: z.literal(60),
  summary: z.object({ severity: severitySchema }),
  findings: z.array(
    z.object({
      type: z.string(),
      severity: severitySchema,
      reason: z.string(),
    }),
  ),
  facts: z.object({ trustworthy: z.boolean() }),
});

type HealthStatus = "healthy" | "degraded" | "failing" | "unknown";
type HealthResult = {
  status: HealthStatus;
  generatedAt?: string;
  dimensions?: Record<(typeof DIMENSIONS)[number], HealthStatus>;
  error?: string;
  sourceStatus?: number;
};
type ReportConfig = {
  baseURL: string;
  token: string;
  branch: string | undefined;
};

// Bound repeated public probes per warm instance, including failures. Never
// serve expired results while refreshing, and coalesce concurrent requests.
let cached:
  | { config: ReportConfig; expiresAt: number; result: Promise<HealthResult> }
  | undefined;

function sameConfig(a: ReportConfig, b: ReportConfig) {
  return (
    a.baseURL === b.baseURL && a.token === b.token && a.branch === b.branch
  );
}

function severityStatus(
  severity: z.infer<typeof severitySchema>,
): HealthStatus {
  return severity === "crit"
    ? "failing"
    : severity === "warn"
      ? "degraded"
      : "healthy";
}

function parseReport(payload: unknown): HealthResult {
  const parsed = reportSchema.safeParse(payload);
  if (!parsed.success) {
    return { status: "unknown", error: "trigger_report_invalid" };
  }
  const report = parsed.data;
  const dimensions = {} as NonNullable<HealthResult["dimensions"]>;
  for (const dimension of DIMENSIONS) {
    const findings = report.findings.filter((item) => item.type === dimension);
    if (findings.length !== 1) {
      return { status: "unknown", error: "trigger_report_invalid" };
    }
    const finding = findings[0];
    dimensions[dimension] = [
      "unknown",
      "freshness_unknown",
      "flow_unmeasured",
    ].includes(finding.reason)
      ? "unknown"
      : severityStatus(finding.severity);
  }

  const statuses = [
    severityStatus(report.summary.severity),
    ...Object.values(dimensions),
  ];
  const status: HealthStatus = !report.facts.trustworthy
    ? "unknown"
    : statuses.includes("failing")
      ? "failing"
      : statuses.includes("unknown")
        ? "unknown"
        : statuses.includes("degraded")
          ? "degraded"
          : "healthy";
  return { status, generatedAt: report.generatedAt, dimensions };
}

async function fetchReport(config: ReportConfig): Promise<HealthResult> {
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${config.token}`,
    };
    if (config.branch) headers["x-trigger-branch"] = config.branch;
    const response = await fetch(new URL(REPORT_PATH, config.baseURL), {
      cache: "no-store",
      redirect: "error",
      signal,
      headers,
    });
    if (!response.ok) {
      return {
        status: "unknown",
        error: "trigger_report_unavailable",
        sourceStatus: response.status,
      };
    }
    const result = parseReport(await response.json());
    console.info(
      JSON.stringify({
        event: "trigger_agent_health_report_received",
        duration_ms: Date.now() - startedAt,
        status: result.status,
      }),
    );
    return result;
  } catch (error) {
    // Fetch errors and upstream bodies can contain credentials or private data.
    const category =
      signal.aborted ||
      (error instanceof Error && error.name === "TimeoutError")
        ? "timeout"
        : error instanceof SyntaxError
          ? "invalid_json"
          : "fetch_failed";
    console.warn(
      JSON.stringify({
        event: "trigger_agent_health_report_fetch_failed",
        category,
        duration_ms: Date.now() - startedAt,
        timeout_ms: FETCH_TIMEOUT_MS,
      }),
    );
    return { status: "unknown", error: `trigger_report_${category}` };
  }
}

export async function GET() {
  // Match @trigger.dev/sdk's environment/branch resolution for Agent runs.
  // The API authenticates into the key's environment; never default to prod.
  const token =
    process.env.TRIGGER_SECRET_KEY ?? process.env.TRIGGER_ACCESS_TOKEN;
  let result: HealthResult;
  if (!token) {
    result = { status: "unknown", error: "trigger_report_not_configured" };
  } else {
    const config: ReportConfig = {
      baseURL: process.env.TRIGGER_API_URL ?? "https://api.trigger.dev",
      token,
      branch:
        process.env.TRIGGER_PREVIEW_BRANCH ??
        process.env.VERCEL_GIT_COMMIT_REF ??
        (process.env.TRIGGER_DEV_BRANCH === "default"
          ? undefined
          : process.env.TRIGGER_DEV_BRANCH),
    };
    if (
      !cached ||
      !sameConfig(cached.config, config) ||
      cached.expiresAt <= Date.now()
    ) {
      cached = {
        config,
        expiresAt: Date.now() + CACHE_TTL_MS,
        result: fetchReport(config),
      };
    }
    result = await cached.result;
  }

  // Check report age even on a cache hit. A recent HTTP response isn't evidence
  // that the underlying report is recent. Allow a small amount of clock skew.
  if (result.generatedAt) {
    const age = Date.now() - Date.parse(result.generatedAt);
    if (age > MAX_REPORT_AGE_MS || age < -30_000) {
      result = {
        status: "unknown",
        error: "trigger_report_stale",
        generatedAt: result.generatedAt,
      };
    }
  }
  const ok = result.status === "healthy" || result.status === "degraded";
  return NextResponse.json(
    {
      ok,
      source: "trigger_report",
      checkedAt: new Date().toISOString(),
      ...result,
    },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
