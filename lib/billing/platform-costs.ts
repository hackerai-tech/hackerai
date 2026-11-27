export type PlatformVendor =
  "vercel" | "convex" | "posthog" | "workos" | "upstash" | "aws";
export type PlatformCostStatus = "billed" | "estimated" | "metered";

export type PlatformCostRow = {
  day: string;
  serviceName: string;
  serviceCategory: string;
  chargeCategory?: string;
  billingCurrency?: string;
  costStatus: PlatformCostStatus;
  billedCostDollars?: number;
  effectiveCostDollars?: number;
  usageQuantity?: number;
  usageUnit?: string;
  sourcePeriodStart: string;
  sourcePeriodEnd: string;
  sourceChargeCount?: number;
  costBasis?: "provider_daily_spend" | "billing_period_allocation";
  billingReference?: string;
};

type VercelFocusCharge = {
  BilledCost?: unknown;
  EffectiveCost?: unknown;
  BillingCurrency?: unknown;
  ChargeCategory?: unknown;
  ChargePeriodStart?: unknown;
  ChargePeriodEnd?: unknown;
  ConsumedQuantity?: unknown;
  ConsumedUnit?: unknown;
  ServiceName?: unknown;
  ServiceCategory?: unknown;
};

export type ConvexDeploymentUsage = {
  metrics: Record<
    string,
    {
      unit: string;
      usage: {
        current_day: number;
        current_month: number;
      };
    }
  >;
  seedStatus: string;
};

const MAX_PLATFORM_ROWS = 5_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, field);
}

function requiredFiniteNumber(value: unknown, field: string): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) {
    throw new Error(`${field} must be finite`);
  }
  return number;
}

function optionalFiniteNumber(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredFiniteNumber(value, field);
}

function utcDayFromIso(value: unknown, field: string): string {
  const iso = requiredString(value, field);
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) throw new Error(`${field} must be an ISO date`);
  return new Date(time).toISOString().slice(0, 10);
}

type Aggregate = PlatformCostRow & {
  hasEffectiveCost: boolean;
  hasUsageQuantity: boolean;
};

function addVercelCharge(
  aggregates: Map<string, Aggregate>,
  charge: VercelFocusCharge,
) {
  const day = utcDayFromIso(charge.ChargePeriodStart, "ChargePeriodStart");
  const sourcePeriodStart = requiredString(
    charge.ChargePeriodStart,
    "ChargePeriodStart",
  );
  const sourcePeriodEnd = requiredString(
    charge.ChargePeriodEnd,
    "ChargePeriodEnd",
  );
  const serviceName = requiredString(charge.ServiceName, "ServiceName");
  const chargeCategory = requiredString(
    charge.ChargeCategory,
    "ChargeCategory",
  );
  const serviceCategory =
    optionalString(charge.ServiceCategory, "ServiceCategory") ?? chargeCategory;
  const billingCurrency = requiredString(
    charge.BillingCurrency,
    "BillingCurrency",
  );
  const usageUnit = optionalString(charge.ConsumedUnit, "ConsumedUnit");
  const billedCostDollars = requiredFiniteNumber(
    charge.BilledCost,
    "BilledCost",
  );
  const effectiveCostDollars = optionalFiniteNumber(
    charge.EffectiveCost,
    "EffectiveCost",
  );
  const usageQuantity = optionalFiniteNumber(
    charge.ConsumedQuantity,
    "ConsumedQuantity",
  );
  const key = JSON.stringify([
    day,
    serviceName,
    serviceCategory,
    chargeCategory,
    billingCurrency,
    usageUnit ?? "",
  ]);
  const existing = aggregates.get(key);

  if (existing) {
    existing.billedCostDollars =
      (existing.billedCostDollars ?? 0) + billedCostDollars;
    if (effectiveCostDollars !== undefined) {
      existing.effectiveCostDollars =
        (existing.effectiveCostDollars ?? 0) + effectiveCostDollars;
      existing.hasEffectiveCost = true;
    }
    if (usageQuantity !== undefined) {
      existing.usageQuantity = (existing.usageQuantity ?? 0) + usageQuantity;
      existing.hasUsageQuantity = true;
    }
    existing.sourcePeriodStart =
      sourcePeriodStart < existing.sourcePeriodStart
        ? sourcePeriodStart
        : existing.sourcePeriodStart;
    existing.sourcePeriodEnd =
      sourcePeriodEnd > existing.sourcePeriodEnd
        ? sourcePeriodEnd
        : existing.sourcePeriodEnd;
    existing.sourceChargeCount = (existing.sourceChargeCount ?? 0) + 1;
    return;
  }

  if (aggregates.size >= MAX_PLATFORM_ROWS) {
    throw new Error(`Vercel response exceeds ${MAX_PLATFORM_ROWS} aggregates`);
  }
  aggregates.set(key, {
    day,
    serviceName,
    serviceCategory,
    chargeCategory,
    billingCurrency,
    costStatus: "billed",
    billedCostDollars,
    effectiveCostDollars,
    usageQuantity,
    usageUnit,
    sourcePeriodStart,
    sourcePeriodEnd,
    sourceChargeCount: 1,
    hasEffectiveCost: effectiveCostDollars !== undefined,
    hasUsageQuantity: usageQuantity !== undefined,
  });
}

function parseVercelLine(line: string, aggregates: Map<string, Aggregate>) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let charge: VercelFocusCharge;
  try {
    charge = JSON.parse(trimmed) as VercelFocusCharge;
  } catch {
    throw new Error("Vercel billing response contains invalid JSONL");
  }
  addVercelCharge(aggregates, charge);
}

/** Stream and aggregate Vercel FOCUS JSONL without buffering the full export. */
export async function parseVercelFocusStream(
  stream: ReadableStream<Uint8Array>,
): Promise<PlatformCostRow[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const aggregates = new Map<string, Aggregate>();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) parseVercelLine(line, aggregates);
  }
  buffer += decoder.decode();
  parseVercelLine(buffer, aggregates);

  return [...aggregates.values()]
    .map(({ hasEffectiveCost, hasUsageQuantity, ...row }) => ({
      ...row,
      effectiveCostDollars: hasEffectiveCost
        ? row.effectiveCostDollars
        : undefined,
      usageQuantity: hasUsageQuantity ? row.usageQuantity : undefined,
    }))
    .sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        a.serviceName.localeCompare(b.serviceName) ||
        a.usageUnit?.localeCompare(b.usageUnit ?? "") ||
        0,
    );
}

/**
 * Keep only rows whose normalized UTC day belongs to the replacement window.
 * Vercel may return a charge period that overlaps the requested range even
 * when that period starts on the preceding day.
 */
export function filterRowsToDayWindow(
  rows: PlatformCostRow[],
  startDay: string,
  endDay: string,
): PlatformCostRow[] {
  return rows.filter((row) => row.day >= startDay && row.day <= endDay);
}

const CONVEX_CATEGORY_BY_METRIC: Record<string, string> = {
  actionComputeConvexGbHours: "compute",
  actionComputeCpuGbHours: "compute",
  actionComputeNodeJsGbHours: "compute",
  dataEgressGb: "network",
  databaseIoGb: "database",
  functionCalls: "operations",
  queryMutationComputeGbHours: "compute",
  searchQueryGb: "search",
};

export function parseConvexDeploymentUsage(
  value: unknown,
): ConvexDeploymentUsage {
  if (!value || typeof value !== "object") {
    throw new Error("Convex usage response must be an object");
  }
  const response = value as Partial<ConvexDeploymentUsage>;
  if (!response.metrics || typeof response.metrics !== "object") {
    throw new Error("Convex usage response is missing metrics");
  }
  if (typeof response.seedStatus !== "string") {
    throw new Error("Convex usage response is missing seedStatus");
  }

  for (const [name, metric] of Object.entries(response.metrics)) {
    if (!metric || typeof metric !== "object") {
      throw new Error(`Convex metric ${name} must be an object`);
    }
    requiredString(metric.unit, `metrics.${name}.unit`);
    requiredFiniteNumber(
      metric.usage?.current_day,
      `metrics.${name}.usage.current_day`,
    );
    requiredFiniteNumber(
      metric.usage?.current_month,
      `metrics.${name}.usage.current_month`,
    );
  }

  return response as ConvexDeploymentUsage;
}

export function mapConvexUsageToRows(
  usage: ConvexDeploymentUsage,
  observedAt: number,
): PlatformCostRow[] {
  if (!Number.isFinite(observedAt))
    throw new Error("observedAt must be finite");
  const start = new Date(observedAt);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + DAY_MS);
  const day = start.toISOString().slice(0, 10);

  return Object.entries(usage.metrics)
    .map(([metricName, metric]) => ({
      day,
      serviceName: metricName,
      serviceCategory: CONVEX_CATEGORY_BY_METRIC[metricName] ?? "other",
      costStatus: "metered" as const,
      usageQuantity: metric.usage.current_day,
      usageUnit: metric.unit,
      sourcePeriodStart: start.toISOString(),
      sourcePeriodEnd: end.toISOString(),
      sourceChargeCount: 1,
    }))
    .sort((a, b) => a.serviceName.localeCompare(b.serviceName));
}

/** Vercel closes billing days at local midnight in this time zone. */
const VERCEL_BILLING_TIME_ZONE = "America/Los_Angeles";

const vercelBillingClock = new Intl.DateTimeFormat("en-US", {
  timeZone: VERCEL_BILLING_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Billing-zone wall-clock time of an instant, encoded as UTC milliseconds. */
function vercelBillingWallClock(instant: number): number {
  const parts = Object.fromEntries(
    vercelBillingClock
      .formatToParts(new Date(instant))
      .map((part) => [part.type, Number(part.value)]),
  );
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

/**
 * UTC instant of 00:00 in the billing zone on a calendar day given as UTC
 * midnight. UTC midnight is the previous local afternoon, and US DST changes
 * at 02:00 local time, so that offset still applies at local midnight.
 */
function vercelBillingMidnight(calendarDay: number): number {
  return calendarDay - (vercelBillingWallClock(calendarDay) - calendarDay);
}

/**
 * Returns the last `days` complete Vercel billing days. `from` and `to` are
 * billing-zone midnights, so the export contains whole provider days; day
 * labels are the billing-zone dates, which match the UTC date of each
 * charge's `ChargePeriodStart`.
 */
export function completedVercelBillingDayWindow(
  now: number,
  days: number,
): { from: string; to: string; startDay: string; endDay: string } {
  if (!Number.isInteger(days) || days < 1) {
    throw new Error("days must be a positive integer");
  }
  if (!Number.isFinite(now)) throw new Error("now must be finite");
  const today = Math.floor(vercelBillingWallClock(now) / DAY_MS) * DAY_MS;
  const firstDay = today - days * DAY_MS;
  return {
    from: new Date(vercelBillingMidnight(firstDay)).toISOString(),
    to: new Date(vercelBillingMidnight(today)).toISOString(),
    startDay: new Date(firstDay).toISOString().slice(0, 10),
    endDay: new Date(today - DAY_MS).toISOString().slice(0, 10),
  };
}

/**
 * Chooses the rows and replacement bounds for a Vercel sync. The replacement
 * ends at the latest day present in the export, so a feed that has not yet
 * published the newest requested day keeps rows an earlier run recorded for
 * it. Earlier days are still fully replaced, including corrections and
 * zero-cost charges. An export with no charges in the window is rejected
 * rather than treated as a request to delete every recorded day.
 */
export function selectVercelReplacement(
  fetchedRows: PlatformCostRow[],
  window: { startDay: string; endDay: string },
): { rows: PlatformCostRow[]; startDay: string; endDay: string } {
  const rows = filterRowsToDayWindow(
    fetchedRows,
    window.startDay,
    window.endDay,
  );
  if (rows.length === 0) {
    throw new Error(
      "Vercel billing response has no charges in the reconciliation window",
    );
  }
  const endDay = rows.reduce(
    (latest, row) => (row.day > latest ? row.day : latest),
    window.startDay,
  );
  return { rows, startDay: window.startDay, endDay };
}

export function convexUsageBaseUrl(configuredUrl: string): string {
  const url = new URL(configuredUrl);
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.convex\.cloud$/.test(url.hostname) ||
    url.port !== "" ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "CONVEX_DEPLOYMENT_URL must be a canonical https://*.convex.cloud URL",
    );
  }
  return url.origin;
}
