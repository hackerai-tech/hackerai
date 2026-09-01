import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  convexUsageBaseUrl,
  mapConvexUsageToRows,
  parseConvexDeploymentUsage,
} from "@/lib/billing/platform-costs";
import {
  fetchWithRetry,
  isAuthorizedCronRequest,
  logCostSync,
  replaceCostWindow,
  requireEnvironment,
  safeError,
} from "@/lib/billing/platform-cost-sync";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: Request) {
  const requestId = request.headers.get("x-vercel-id") ?? randomUUID();
  if (!isAuthorizedCronRequest(request)) {
    logCostSync("warn", "platform_cost_sync_unauthorized", {
      request_id: requestId,
      vendor: "convex",
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const deployKey = requireEnvironment("CONVEX_DEPLOY_KEY");
    const convexUrl = convexUsageBaseUrl(
      requireEnvironment("CONVEX_DEPLOYMENT_URL"),
    );
    const usage = await fetchWithRetry(
      `${convexUrl.replace(/\/$/, "")}/api/v1/get_current_usage`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Convex ${deployKey}`,
          "Convex-Client": "hackerai-platform-cost-sync/1.0",
          "User-Agent": "hackerai-platform-cost-sync/1.0",
        },
        cache: "no-store",
      },
      async (response) => parseConvexDeploymentUsage(await response.json()),
    );
    const observedAt = Date.now();
    const rows = mapConvexUsageToRows(usage, observedAt);
    const day = new Date(observedAt).toISOString().slice(0, 10);
    const result = await replaceCostWindow({
      vendor: "convex",
      startDay: day,
      endDay: day,
      observedAt,
      rows,
    });

    logCostSync("info", "platform_cost_sync_completed", {
      request_id: requestId,
      vendor: "convex",
      duration_ms: Date.now() - startedAt,
      row_count: rows.length,
      day,
      seed_status: usage.seedStatus,
      ...result,
    });
    return NextResponse.json({ ok: true, rowCount: rows.length, ...result });
  } catch (error) {
    logCostSync("error", "platform_cost_sync_failed", {
      request_id: requestId,
      vendor: "convex",
      duration_ms: Date.now() - startedAt,
      ...safeError(error),
    });
    return NextResponse.json({ error: "Cost sync failed" }, { status: 500 });
  }
}
