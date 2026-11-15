import {
  GetCostAndUsageCommand,
  type CostExplorerClient,
  type GetCostAndUsageCommandOutput,
} from "@aws-sdk/client-cost-explorer";
import type { PlatformCostRow } from "./platform-costs";
import { utcDayTime } from "./operating-costs";

const DAY_MS = 86_400_000;
const MAX_PAGES = 100;
const MAX_ROWS = 5_000;

function amount(metric: { Amount?: string; Unit?: string } | undefined) {
  if (
    metric?.Unit !== "USD" ||
    typeof metric.Amount !== "string" ||
    !/^-?\d+(?:\.\d+)?$/.test(metric.Amount)
  )
    throw new Error("AWS cost amount or currency is unknown");
  const value = Number(metric.Amount);
  if (!Number.isFinite(value) || Math.abs(value) > 1e9)
    throw new Error("Invalid AWS cost amount");
  return value;
}

/** Cost Explorer spend is provisional, including historical non-estimated data. */
export function normalizeAwsCostPages(
  pages: GetCostAndUsageCommandOutput[],
  startDay: string,
  endDay: string,
): PlatformCostRow[] {
  const start = utcDayTime(startDay),
    end = utcDayTime(endDay);
  if (
    end < start ||
    end - start >= 366 * DAY_MS ||
    !pages.length ||
    pages.length > MAX_PAGES ||
    pages.at(-1)?.NextPageToken
  )
    throw new Error("Incomplete AWS cost window or pagination");
  const covered = new Set<string>();
  const zeroDays = new Set<string>();
  const rows = new Map<string, PlatformCostRow>();
  for (const page of pages) {
    if (
      page.GroupDefinitions?.length !== 2 ||
      page.GroupDefinitions[0].Key !== "SERVICE" ||
      page.GroupDefinitions[1].Key !== "RECORD_TYPE" ||
      page.GroupDefinitions.some((group) => group.Type !== "DIMENSION") ||
      !Array.isArray(page.ResultsByTime)
    )
      throw new Error("Unexpected AWS cost dimensions or result shape");
    for (const result of page.ResultsByTime) {
      const day = result.TimePeriod?.Start;
      if (
        !day ||
        utcDayTime(day) < start ||
        utcDayTime(day) > end ||
        result.TimePeriod?.End !==
          new Date(utcDayTime(day) + DAY_MS).toISOString().slice(0, 10) ||
        !Array.isArray(result.Groups)
      )
        throw new Error("Invalid AWS daily cost period");
      if (!result.Groups.length) {
        // A completed grouped response explicitly reports no charge records.
        // Missing dates/groups still fail; an optional total must agree with zero.
        if (
          result.Total?.UnblendedCost &&
          amount(result.Total.UnblendedCost) !== 0
        )
          throw new Error("AWS empty groups disagree with the total");
        zeroDays.add(day);
        continue;
      }
      for (const group of result.Groups) {
        if (
          group.Keys?.length !== 2 ||
          group.Keys.some((key) => !key.trim() || key.length > 300)
        )
          throw new Error("Invalid AWS service identity");
        const [service, chargeType] = group.Keys;
        const cost = amount(group.Metrics?.UnblendedCost);
        const key = JSON.stringify([day, service, chargeType]);
        if (rows.has(key)) throw new Error("Duplicate AWS service/day charge");
        if (rows.size >= MAX_ROWS)
          throw new Error("AWS cost window is too large");
        covered.add(day);
        rows.set(key, {
          day,
          serviceName: service,
          serviceCategory: "infrastructure",
          chargeCategory: chargeType,
          billingCurrency: "USD",
          costStatus: "estimated",
          effectiveCostDollars: cost,
          sourcePeriodStart: `${day}T00:00:00.000Z`,
          sourcePeriodEnd: `${result.TimePeriod.End}T00:00:00.000Z`,
          sourceChargeCount: 1,
          costBasis: "provider_daily_spend",
          billingReference: "cost-explorer:UnblendedCost",
        });
      }
    }
  }
  for (let time = start; time <= end; time += DAY_MS) {
    const day = new Date(time).toISOString().slice(0, 10);
    if (covered.has(day)) continue;
    if (!zeroDays.has(day))
      throw new Error("AWS cost response has missing days");
    rows.set(day, {
      day,
      serviceName: "account-total",
      serviceCategory: "infrastructure",
      chargeCategory: "explicit-zero",
      billingCurrency: "USD",
      costStatus: "estimated",
      effectiveCostDollars: 0,
      sourcePeriodStart: `${day}T00:00:00.000Z`,
      sourcePeriodEnd: new Date(time + DAY_MS).toISOString(),
      sourceChargeCount: 1,
      costBasis: "provider_daily_spend",
      billingReference: "cost-explorer:UnblendedCost",
    });
  }
  if (rows.size > MAX_ROWS) throw new Error("AWS cost window is too large");
  return [...rows.values()];
}

export async function fetchAwsCostWindow(
  client: Pick<CostExplorerClient, "send">,
  accountId: string,
  startDay: string,
  endDay: string,
): Promise<PlatformCostRow[]> {
  if (!/^\d{12}$/.test(accountId)) throw new Error("Invalid AWS account");
  const timePeriod = {
    Start: startDay,
    End: new Date(utcDayTime(endDay) + DAY_MS).toISOString().slice(0, 10),
  };
  const read = async (billingEntity: "AWS" | "AWS Marketplace") => {
    const pages: GetCostAndUsageCommandOutput[] = [];
    const tokens = new Set<string>();
    let token: string | undefined;
    do {
      if (pages.length >= MAX_PAGES)
        throw new Error("AWS pagination limit reached");
      const page = await client.send(
        new GetCostAndUsageCommand({
          TimePeriod: timePeriod,
          Granularity: "DAILY",
          Metrics: ["UnblendedCost"],
          GroupBy: [
            { Type: "DIMENSION", Key: "SERVICE" },
            { Type: "DIMENSION", Key: "RECORD_TYPE" },
          ],
          Filter: {
            And: [
              { Dimensions: { Key: "LINKED_ACCOUNT", Values: [accountId] } },
              {
                Dimensions: { Key: "BILLING_ENTITY", Values: [billingEntity] },
              },
            ],
          },
          ...(token ? { NextPageToken: token } : {}),
        }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );
      pages.push(page);
      token = page.NextPageToken;
      if (token) {
        if (tokens.has(token))
          throw new Error("AWS pagination did not advance");
        tokens.add(token);
      }
    } while (token);
    return normalizeAwsCostPages(pages, startDay, endDay);
  };
  // Inspect individual records so charges and refunds cannot cancel to zero.
  const marketplace = await read("AWS Marketplace");
  if (marketplace.some((row) => row.effectiveCostDollars !== 0))
    throw new Error("AWS Marketplace charges require vendor reconciliation");
  // Filter at the provider, so a later Marketplace correction cannot enter the
  // AWS-only response between the reconciliation check and this request.
  return read("AWS");
}
