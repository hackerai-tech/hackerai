import { NextResponse } from "next/server";
import { readTriggerHealth } from "@/lib/health/trigger-health";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 10;

export async function GET() {
  const { probe, report, reportAttemptAt, reportRefreshError } =
    await readTriggerHealth();
  const ok = probe.status === "healthy";
  return NextResponse.json(
    {
      ok,
      source: "trigger_probe",
      ...probe,
      report: {
        ...report,
        attemptedAt: reportAttemptAt,
        refreshError: reportRefreshError,
      },
    },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
