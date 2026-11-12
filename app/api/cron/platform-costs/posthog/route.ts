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
    const customer = requireEnvironment("POSTHOG_BILLING_CUSTOMER_ID");
    const projectIds = projects.split(",").map(Number);
    if (
      !/^[0-9a-f-]{36}$/i.test(organization) ||
      !/^\d+(,\d+)*$/.test(projects) ||
      projectIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(projectIds).size !== projectIds.length ||
      !/^[1-9]\d*$/.test(customer) ||
      !Number.isSafeInteger(Number(customer))
    ) {
      throw new Error("Invalid billing scope");
    }
    const window = completedUtcDayWindow(observedAt, 35);
    // The organization REST endpoint is beta-gated. The billing endpoint is
    // available to billing:read keys; pin its organization and customer, too.
    const url = new URL("https://us.posthog.com/api/billing/spend/");
    url.searchParams.set("organization_id", organization);
    url.searchParams.set("start_date", window.startDay);
    url.searchParams.set("end_date", window.endDay);
    url.searchParams.set("interval", "day");
    // PostHog requires a JSON array here, not comma-separated IDs.
    url.searchParams.set("team_ids", JSON.stringify(projectIds));
    const rows = await fetchWithRetry(
      url.toString(),
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
      async (response) => {
        const payload = await response.json();
        if (payload?.customer_id !== Number(customer)) {
          throw new Error(
            "Billing customer does not match the configured account",
          );
        }
        return parsePostHogSpend(payload, window.startDay, window.endDay);
      },
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
