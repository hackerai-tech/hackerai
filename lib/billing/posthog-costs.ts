import type { PlatformCostRow } from "./platform-costs";

/**
 * Normalize the aggregate billing-spend response, not per-product breakdowns.
 * Spend is provisional until invoiced. A partial response must never replace
 * a complete persisted window, and a missing day is not a zero-cost day.
 */
export function parsePostHogSpend(
  value: unknown,
  startDay: string,
  endDay: string,
): PlatformCostRow[] {
  const first = Date.parse(`${startDay}T00:00:00.000Z`);
  const last = Date.parse(`${endDay}T00:00:00.000Z`);
  if (
    !Number.isFinite(first) ||
    !Number.isFinite(last) ||
    first > last ||
    new Date(first).toISOString().slice(0, 10) !== startDay ||
    new Date(last).toISOString().slice(0, 10) !== endDay ||
    (last - first) / 86_400_000 >= 35
  )
    throw new Error(
      "PostHog spend window must contain between 1 and 35 UTC days",
    );
  const payload = value as {
    status?: unknown;
    next?: unknown;
    results?: Array<{
      id?: unknown;
      data?: unknown[];
      dates?: unknown[];
      breakdown_type?: unknown;
      breakdown_value?: unknown;
    }>;
  } | null;
  if (
    !payload ||
    payload.status !== "ok" ||
    payload.next ||
    !Array.isArray(payload.results) ||
    payload.results.length !== 1
  ) {
    throw new Error("PostHog spend must contain one complete aggregate series");
  }
  const series = payload.results[0];
  if (
    series.breakdown_type != null ||
    series.breakdown_value != null ||
    !Array.isArray(series.data) ||
    !Array.isArray(series.dates) ||
    series.data.length !== series.dates.length
  ) {
    throw new Error("PostHog spend aggregate has an invalid shape");
  }
  const byDay = new Map<string, number>();
  for (let i = 0; i < series.dates.length; i++) {
    const day = series.dates[i];
    const dollars = series.data[i];
    if (
      typeof day !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(Date.parse(`${day}T00:00:00.000Z`)) ||
      new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day ||
      day < startDay ||
      day > endDay ||
      byDay.has(day) ||
      typeof dollars !== "number" ||
      !Number.isFinite(dollars)
    ) {
      throw new Error(
        "PostHog spend contains an invalid or duplicate daily cost",
      );
    }
    byDay.set(day, dollars);
  }
  const rows: PlatformCostRow[] = [];
  for (let time = first; time <= last; time += 86_400_000) {
    const day = new Date(time).toISOString().slice(0, 10);
    const dollars = byDay.get(day);
    if (dollars === undefined)
      throw new Error("PostHog spend is missing a UTC day");
    rows.push({
      day,
      serviceName: "product-analytics",
      serviceCategory: "analytics",
      billingCurrency: "USD",
      costStatus: "estimated",
      effectiveCostDollars: dollars,
      sourcePeriodStart: new Date(time).toISOString(),
      sourcePeriodEnd: new Date(time + 86_400_000).toISOString(),
      sourceChargeCount: 1,
    });
  }
  return rows;
}
