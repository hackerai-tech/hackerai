import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  completedUtcDayWindow,
  filterRowsToDayWindow,
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

/** Reconciles completed Vercel billing days into the platform cost table. */
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
  try {
    const token = requireEnvironment("VERCEL_BILLING_READ_TOKEN");
    const teamId = requireEnvironment("VERCEL_BILLING_TEAM_ID");
    const window = completedUtcDayWindow(startedAt, RECONCILIATION_DAYS);
    const url = new URL("https://api.vercel.com/v1/billing/charges");
    url.searchParams.set("from", window.from);
    url.searchParams.set("to", window.to);
    url.searchParams.set("teamId", teamId);

    const fetchedRows = await fetchWithRetry(
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
    const rows = filterRowsToDayWindow(
      fetchedRows,
      window.startDay,
      window.endDay,
    );
    const result = await replaceCostWindow({
      vendor: "vercel",
      startDay: window.startDay,
      endDay: window.endDay,
      observedAt: startedAt,
      rows,
    });

    logCostSync("info", "platform_cost_sync_completed", {
      request_id: requestId,
      vendor: "vercel",
      duration_ms: Date.now() - startedAt,
      row_count: rows.length,
      excluded_row_count: fetchedRows.length - rows.length,
      start_day: window.startDay,
      end_day: window.endDay,
      ...result,
    });
    return NextResponse.json({ ok: true, rowCount: rows.length, ...result });
  } catch (error) {
    logCostSync("error", "platform_cost_sync_failed", {
      request_id: requestId,
      vendor: "vercel",
      duration_ms: Date.now() - startedAt,
      ...safeError(error),
    });
    return NextResponse.json({ error: "Cost sync failed" }, { status: 500 });
  }
}
