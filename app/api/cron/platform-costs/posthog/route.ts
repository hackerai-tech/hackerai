import { NextResponse } from "next/server";
import { completedUtcDayWindow } from "@/lib/billing/platform-costs";
import { parsePostHogSpend } from "@/lib/billing/posthog-costs";
import {
  fetchWithRetry,
  isAuthorizedCronRequest,
  logCostSync,
  replaceCostWindow,
  requireEnvironment,
} from "@/lib/billing/platform-cost-sync";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Shared operating spend. Never added to customer usage or provider totals. */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Billing read access is separate from ingestion/sourcemap keys. Keep this
  // explicit until the environment has a verified, organization-scoped reader.
  if (!process.env.POSTHOG_BILLING_READ_TOKEN?.trim()) {
    logCostSync("warn", "platform_cost_sync_not_configured", {
      vendor: "posthog",
    });
    return NextResponse.json(
      { error: "Billing reader not configured" },
      { status: 503 },
    );
  }
  try {
    const observedAt = Date.now();
    const token = requireEnvironment("POSTHOG_BILLING_READ_TOKEN");
    const organization = requireEnvironment("POSTHOG_BILLING_ORGANIZATION_ID");
    const projects = requireEnvironment("POSTHOG_BILLING_PROJECT_IDS");
    if (
      !/^[0-9a-f-]{36}$/i.test(organization) ||
      !/^\d+(,\d+)*$/.test(projects) ||
      new Set(projects.split(",")).size !== projects.split(",").length
    ) {
      throw new Error("Invalid billing scope");
    }
    const window = completedUtcDayWindow(observedAt, 7);
    // Organization-scoped endpoint prevents the active/default project from
    // silently selecting a different organization's billing account.
    const url = new URL(
      `https://us.posthog.com/api/organizations/${organization}/billing/spend/timeseries/`,
    );
    url.searchParams.set("start_date", window.startDay);
    url.searchParams.set("end_date", window.endDay);
    url.searchParams.set("interval", "day");
    url.searchParams.set("team_ids", projects);
    const rows = await fetchWithRetry(
      url.toString(),
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
      async (response) =>
        parsePostHogSpend(
          await response.json(),
          window.startDay,
          window.endDay,
        ),
    );
    const result = await replaceCostWindow({
      vendor: "posthog",
      startDay: window.startDay,
      endDay: window.endDay,
      observedAt,
      rows,
    });
    logCostSync("info", "platform_cost_sync_completed", {
      vendor: "posthog",
      row_count: rows.length,
      ...result,
    });
    return NextResponse.json({ ok: true, rowCount: rows.length, ...result });
  } catch {
    // Provider errors can include response bodies or request authorization.
    logCostSync("error", "platform_cost_sync_failed", { vendor: "posthog" });
    return NextResponse.json({ error: "Cost sync failed" }, { status: 500 });
  }
}
