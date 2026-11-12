import type { PlatformCostRow } from "./platform-costs";

const DAY_MS = 86_400_000;
export type BillingPeriod = {
  start: string;
  end: string;
  totalDollars: number;
  currency: "USD";
  reference: string;
  status: "billed" | "estimated";
};

export function utcDayTime(day: string): number {
  const time = Date.parse(`${day}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== day
  ) {
    throw new Error("Invalid UTC billing date");
  }
  return time;
}

function money(amount: number) {
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    Math.abs(amount) > 1e9
  ) {
    throw new Error("Invalid billing amount");
  }
  return amount;
}

function windowDays(startDay: string, endDay: string) {
  const start = utcDayTime(startDay),
    end = utcDayTime(endDay);
  if (end < start || (end - start) / DAY_MS >= 366)
    throw new Error("Invalid billing window");
  const days: string[] = [];
  for (let t = start; t <= end; t += DAY_MS)
    days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

/** Provider invoices are exact at period level. Daily amounts are allocations. */
export function allocateBillingPeriods(
  periods: BillingPeriod[],
  startDay: string,
  endDay: string,
  serviceName: string,
  serviceCategory: string,
): PlatformCostRow[] {
  const days = windowDays(startDay, endDay);
  if (!periods.length || periods.length > 24)
    throw new Error("Missing or excessive billing periods");
  const selected = new Map<string, BillingPeriod>();
  for (const period of periods) {
    const start = utcDayTime(period.start),
      end = utcDayTime(period.end);
    const count = (end - start) / DAY_MS;
    const cents = Math.round(money(period.totalDollars) * 100);
    if (
      period.currency !== "USD" ||
      !["billed", "estimated"].includes(period.status) ||
      !period.reference ||
      period.reference.length > 200 ||
      count < 1 ||
      count > 366 ||
      Math.abs(cents / 100 - period.totalDollars) > 1e-7
    ) {
      throw new Error("Invalid billing period");
    }
    const key = `${period.start}/${period.end}`;
    const previous = selected.get(key);
    if (previous) {
      if (previous.status === period.status)
        throw new Error("Duplicate billing period");
      if (previous.status === "billed") continue;
    }
    selected.set(key, period);
  }
  const ordered = [...selected.values()].sort((a, b) =>
    a.start.localeCompare(b.start),
  );
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].start < ordered[i - 1].end)
      throw new Error("Overlapping billing periods");
  }
  const rows = new Map<string, PlatformCostRow>();
  for (const period of ordered) {
    const start = utcDayTime(period.start),
      end = utcDayTime(period.end);
    const count = (end - start) / DAY_MS;
    const cents = Math.round(period.totalDollars * 100);
    const base = Math.trunc(cents / count),
      remainder = cents - base * count;
    for (let index = 0; index < count; index++) {
      const day = new Date(start + index * DAY_MS).toISOString().slice(0, 10);
      if (day < startDay || day > endDay) continue;
      const amount =
        (base + (index < Math.abs(remainder) ? Math.sign(remainder) : 0)) / 100;
      rows.set(day, {
        day,
        serviceName,
        serviceCategory,
        chargeCategory: "billing-period",
        billingCurrency: "USD",
        costStatus: period.status,
        ...(period.status === "billed"
          ? { billedCostDollars: amount }
          : { effectiveCostDollars: amount }),
        sourcePeriodStart: new Date(start).toISOString(),
        sourcePeriodEnd: new Date(end).toISOString(),
        sourceChargeCount: 1,
        costBasis: "billing_period_allocation",
        billingReference: period.reference,
      });
    }
  }
  if (days.some((day) => !rows.has(day)))
    throw new Error("Billing window has missing days");
  return days.map((day) => rows.get(day)!);
}

export type RedisCostObservation = {
  databaseId: string;
  dailyBilling: Array<{ x: string; y: number }>;
};

/** Stats already include the fixed-plan charge. Never add the plan price again. */
export function normalizeUpstashCosts(
  observations: RedisCostObservation[],
  expectedDatabaseIds: string[],
  startDay: string,
  endDay: string,
): PlatformCostRow[] {
  const days = windowDays(startDay, endDay);
  const expected = new Set(expectedDatabaseIds);
  if (
    !expected.size ||
    expected.size > 50 ||
    expected.size !== expectedDatabaseIds.length ||
    observations.length !== expected.size
  )
    throw new Error("Incomplete Redis resource scope");
  const seen = new Set<string>();
  const rows: PlatformCostRow[] = [];
  for (const observation of observations) {
    if (
      !expected.has(observation.databaseId) ||
      seen.has(observation.databaseId)
    ) {
      throw new Error("Unexpected or duplicate Redis resource");
    }
    seen.add(observation.databaseId);
    const amounts = new Map<string, number>();
    if (
      !Array.isArray(observation.dailyBilling) ||
      observation.dailyBilling.length > 366
    ) {
      throw new Error("Invalid Redis billing series");
    }
    for (const point of observation.dailyBilling) {
      // Upstash uses a Go timestamp with nanoseconds, which Date.parse cannot read.
      if (
        typeof point.x !== "string" ||
        !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? \+0000 UTC$/.test(
          point.x,
        )
      ) {
        throw new Error("Redis billing timestamp is not UTC");
      }
      const day = point.x.slice(0, 10);
      utcDayTime(day);
      if (amounts.has(day)) throw new Error("Duplicate Redis billing date");
      amounts.set(day, money(point.y));
    }
    for (const day of days) {
      const amount = amounts.get(day);
      if (amount === undefined)
        throw new Error("Redis billing has missing days");
      const time = utcDayTime(day);
      rows.push({
        day,
        serviceName: `redis:${observation.databaseId}`,
        serviceCategory: "cache",
        chargeCategory: "daily-billing",
        billingCurrency: "USD",
        costStatus: "estimated",
        effectiveCostDollars: amount,
        sourcePeriodStart: new Date(time).toISOString(),
        sourcePeriodEnd: new Date(time + DAY_MS).toISOString(),
        sourceChargeCount: 1,
        costBasis: "provider_daily_spend",
        billingReference: observation.databaseId,
      });
    }
  }
  return rows;
}

export type OperatingImport = {
  vendor: "workos" | "upstash" | "convex";
  startDay: string;
  endDay: string;
  observedAt: number;
  rows: PlatformCostRow[];
};

export type ConvexBillingInvoice = {
  reference: string;
  currency: "USD";
  status: "billed" | "estimated";
  /** Net amount due after applied invoice balance, not the dashboard subtotal. */
  totalDollars: number;
  parts: Array<{ start: string; end: string; subtotalDollars: number }>;
};

export type ConvexBillingAccount = {
  teamId: number;
  invoices: ConvexBillingInvoice[];
};

/** Preserve net invoice cents while splitting prepaid fees and prior overage. */
export function allocateNetInvoice(invoice: ConvexBillingInvoice): number[] {
  const total = Math.round(money(invoice.totalDollars) * 100);
  if (
    invoice.currency !== "USD" ||
    !["billed", "estimated"].includes(invoice.status) ||
    !invoice.reference ||
    invoice.reference.length > 120 ||
    Math.abs(total / 100 - invoice.totalDollars) > 1e-7 ||
    !Array.isArray(invoice.parts) ||
    !invoice.parts.length ||
    invoice.parts.length > 128
  ) {
    throw new Error("Invalid Convex invoice");
  }
  const weights = invoice.parts.map((part) => {
    const start = utcDayTime(part.start),
      end = utcDayTime(part.end);
    const cents = Math.round(money(part.subtotalDollars) * 100);
    if (
      end <= start ||
      end - start > 366 * DAY_MS ||
      cents < 0 ||
      Math.abs(cents / 100 - part.subtotalDollars) > 1e-7
    ) {
      throw new Error("Invalid Convex invoice service period");
    }
    return BigInt(cents);
  });
  const weight = weights.reduce((n, value) => n + value, BigInt(0));
  if (weight === BigInt(0)) {
    if (total !== 0)
      throw new Error("Convex invoice amount has no service-period allocation");
    return weights.map(() => 0);
  }
  const magnitude = BigInt(Math.abs(total));
  const parts = weights.map((value, index) => ({
    index,
    cents: (magnitude * value) / weight,
    remainder: (magnitude * value) % weight,
  }));
  let residual =
    magnitude - parts.reduce((n, part) => n + part.cents, BigInt(0));
  for (const part of [...parts].sort((a, b) =>
    a.remainder === b.remainder
      ? a.index - b.index
      : a.remainder > b.remainder
        ? -1
        : 1,
  )) {
    if (residual === BigInt(0)) break;
    part.cents += BigInt(1);
    residual -= BigInt(1);
  }
  return parts.map((part) => (Number(part.cents) * Math.sign(total)) / 100);
}

export function normalizeConvexInvoices(
  accounts: ConvexBillingAccount[],
  expectedTeamIds: number[],
  startDay: string,
  endDay: string,
): PlatformCostRow[] {
  const days = windowDays(startDay, endDay);
  const expected = new Set(expectedTeamIds),
    seen = new Set<number>();
  if (
    !expected.size ||
    expected.size > 10 ||
    expected.size !== expectedTeamIds.length ||
    accounts.length !== expected.size ||
    expectedTeamIds.some((id) => !Number.isSafeInteger(id) || id < 1)
  )
    throw new Error("Incomplete Convex billing account scope");
  const rows: PlatformCostRow[] = [];
  for (const account of accounts) {
    if (
      !expected.has(account.teamId) ||
      seen.has(account.teamId) ||
      !Array.isArray(account.invoices) ||
      !account.invoices.length ||
      account.invoices.length > 64
    )
      throw new Error("Unexpected Convex billing account or invoices");
    seen.add(account.teamId);
    const invoices = new Set<string>();
    const daily = new Map<
      string,
      {
        cents: number;
        estimated: boolean;
        start: string;
        end: string;
        references: Set<string>;
      }
    >();
    for (const invoice of account.invoices) {
      if (invoices.has(invoice.reference))
        throw new Error("Duplicate Convex invoice reference");
      invoices.add(invoice.reference);
      const amounts = allocateNetInvoice(invoice);
      for (let index = 0; index < invoice.parts.length; index++) {
        const part = invoice.parts[index];
        const lastDay = new Date(utcDayTime(part.end) - DAY_MS)
          .toISOString()
          .slice(0, 10);
        const allocations = allocateBillingPeriods(
          [
            {
              start: part.start,
              end: part.end,
              totalDollars: amounts[index],
              currency: "USD",
              reference: invoice.reference,
              status: invoice.status,
            },
          ],
          part.start,
          lastDay,
          "billing",
          "database",
        );
        for (const allocation of allocations) {
          if (allocation.day < startDay || allocation.day > endDay) continue;
          const existing = daily.get(allocation.day) ?? {
            cents: 0,
            estimated: false,
            start: part.start,
            end: part.end,
            references: new Set<string>(),
          };
          existing.cents += Math.round(
            (allocation.billedCostDollars ?? allocation.effectiveCostDollars!) *
              100,
          );
          existing.estimated ||= invoice.status === "estimated";
          existing.start =
            existing.start < part.start ? existing.start : part.start;
          existing.end = existing.end > part.end ? existing.end : part.end;
          existing.references.add(invoice.reference);
          daily.set(allocation.day, existing);
        }
      }
    }
    if (days.some((day) => !daily.has(day)))
      throw new Error("Convex invoices have missing account/day coverage");
    for (const day of days) {
      const value = daily.get(day)!;
      const reference = [...value.references].sort().join(",");
      if (reference.length > 200)
        throw new Error(
          "Convex invoice provenance exceeds the bounded reference",
        );
      rows.push({
        day,
        serviceName: `team-billing:${account.teamId}`,
        serviceCategory: "database",
        chargeCategory: "billing-period",
        billingCurrency: "USD",
        costStatus: value.estimated ? "estimated" : "billed",
        ...(value.estimated
          ? { effectiveCostDollars: value.cents / 100 }
          : { billedCostDollars: value.cents / 100 }),
        sourcePeriodStart: new Date(utcDayTime(value.start)).toISOString(),
        sourcePeriodEnd: new Date(utcDayTime(value.end)).toISOString(),
        sourceChargeCount: value.references.size,
        costBasis: "billing_period_allocation",
        billingReference: reference,
      });
    }
  }
  return rows;
}

/** A connector snapshot carries billing numbers, never vendor credentials. */
export function prepareOperatingImport(
  value: unknown,
  scope: {
    workosTeamName?: string;
    upstashDatabaseIds?: string[];
    convexTeamId?: number;
    convexTeamIds?: number[];
  },
  now = Date.now(),
): OperatingImport {
  const snapshot = value as {
    vendor?: string;
    observedAt?: string;
    startDay?: string;
    endDay?: string;
    workosTeamName?: string;
    convexTeamId?: number;
    billingPeriods?: BillingPeriod[];
    redisBilling?: RedisCostObservation[];
    convexBilling?: ConvexBillingAccount[];
  } | null;
  if (
    !snapshot ||
    typeof snapshot.observedAt !== "string" ||
    typeof snapshot.startDay !== "string" ||
    typeof snapshot.endDay !== "string"
  ) {
    throw new Error("Invalid operating-cost snapshot");
  }
  const observedAt = Date.parse(snapshot.observedAt);
  if (
    !Number.isFinite(observedAt) ||
    observedAt > now + 300_000 ||
    now - observedAt > 48 * 3_600_000
  ) {
    throw new Error("Billing observation is stale or in the future");
  }
  if (
    utcDayTime(snapshot.endDay) >=
    utcDayTime(new Date(now).toISOString().slice(0, 10))
  ) {
    throw new Error("Only complete UTC days can be imported");
  }
  const { startDay, endDay } = snapshot;
  let rows: PlatformCostRow[];
  if (snapshot.vendor === "upstash") {
    if (!scope.upstashDatabaseIds || !snapshot.redisBilling)
      throw new Error("Missing Redis source scope");
    rows = normalizeUpstashCosts(
      snapshot.redisBilling,
      scope.upstashDatabaseIds,
      startDay,
      endDay,
    );
  } else if (snapshot.vendor === "convex" && snapshot.convexBilling) {
    if (!scope.convexTeamIds)
      throw new Error("Missing Convex billing account scope");
    rows = normalizeConvexInvoices(
      snapshot.convexBilling,
      scope.convexTeamIds,
      startDay,
      endDay,
    );
  } else if (snapshot.vendor === "workos" || snapshot.vendor === "convex") {
    if (
      snapshot.vendor === "workos" &&
      (!scope.workosTeamName ||
        snapshot.workosTeamName !== scope.workosTeamName)
    ) {
      throw new Error("WorkOS workspace does not match the configured source");
    }
    if (
      snapshot.vendor === "convex" &&
      (!scope.convexTeamId || snapshot.convexTeamId !== scope.convexTeamId)
    ) {
      throw new Error(
        "Convex billing account does not match the configured source",
      );
    }
    if (!Array.isArray(snapshot.billingPeriods))
      throw new Error("Missing billing periods");
    rows = allocateBillingPeriods(
      snapshot.billingPeriods,
      startDay,
      endDay,
      snapshot.vendor === "workos" ? "workspace-billing" : "team-billing",
      snapshot.vendor === "workos" ? "identity" : "database",
    );
  } else throw new Error("Unsupported operating-cost vendor");
  return { vendor: snapshot.vendor, startDay, endDay, observedAt, rows };
}
