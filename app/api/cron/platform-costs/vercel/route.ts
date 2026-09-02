import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  completedUtcDayWindow,
  partitionPlatformCostRowsByDayWindow,
  parseVercelFocusStream,
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

const RECONCILIATION_DAYS = 35;

/** Reconcile the completed Vercel billing window into persisted daily costs. */
export async function GET(request: Request) {
  const requestId = request.headers.get("x-vercel-id") ?? randomUUID();
  if (!isAuthorizedCronRequest(request)) {
    logCostSync("warn", "platform_cost_sync_unauthorized", {
      request_id: requestId,
      vendor: "vercel",
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  let stage: "configuration" | "fetch" | "normalize" | "persist" | "complete" =
    "configuration";
  try {
    const token = requireEnvironment("VERCEL_BILLING_READ_TOKEN");
    const teamId = requireEnvironment("VERCEL_BILLING_TEAM_ID");
    const window = completedUtcDayWindow(startedAt, RECONCILIATION_DAYS);
    const url = new URL("https://api.vercel.com/v1/billing/charges");
    url.searchParams.set("from", window.from);
    url.searchParams.set("to", window.to);
    url.searchParams.set("teamId", teamId);

    stage = "fetch";
    const upstreamRows = await fetchWithRetry(
      url.toString(),
      {
        headers: {
          Accept: "application/jsonl",
          Authorization: `Bearer ${token}`,
          "User-Agent": "hackerai-platform-cost-sync/1.0",
        },
        cache: "no-store",
      },
      async (response) => {
        if (!response.body) {
          throw new Error("Vercel billing response has no body");
        }
        return await parseVercelFocusStream(response.body);
      },
    );
    stage = "normalize";
    const partition = partitionPlatformCostRowsByDayWindow(
      upstreamRows,
      window.startDay,
      window.endDay,
    );
    const excludedRowCount =
      partition.excludedBeforeStart + partition.excludedAfterEnd;
    if (excludedRowCount > 0) {
      logCostSync("warn", "platform_cost_sync_rows_excluded_outside_window", {
        request_id: requestId,
        vendor: "vercel",
        start_day: window.startDay,
        end_day: window.endDay,
        upstream_row_count: upstreamRows.length,
        excluded_row_count: excludedRowCount,
        excluded_before_start: partition.excludedBeforeStart,
        excluded_after_end: partition.excludedAfterEnd,
      });
    }
    if (upstreamRows.length > 0 && partition.rows.length === 0) {
      throw new Error(
        "Vercel billing response contains no rows inside the requested window",
      );
    }

    stage = "persist";
    const result = await replaceCostWindow({
      vendor: "vercel",
      startDay: window.startDay,
      endDay: window.endDay,
      observedAt: startedAt,
      rows: partition.rows,
    });

    stage = "complete";
    logCostSync("info", "platform_cost_sync_completed", {
      request_id: requestId,
      vendor: "vercel",
      duration_ms: Date.now() - startedAt,
      row_count: partition.rows.length,
      upstream_row_count: upstreamRows.length,
      excluded_row_count: excludedRowCount,
      start_day: window.startDay,
      end_day: window.endDay,
      ...result,
    });
    return NextResponse.json({
      ok: true,
      rowCount: partition.rows.length,
      ...result,
    });
  } catch (error) {
    logCostSync("error", "platform_cost_sync_failed", {
      request_id: requestId,
      vendor: "vercel",
      stage,
      duration_ms: Date.now() - startedAt,
      ...safeError(error),
    });
    return NextResponse.json({ error: "Cost sync failed" }, { status: 500 });
  }
}
