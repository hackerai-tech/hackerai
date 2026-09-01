import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";

const MAX_ROWS_PER_SYNC = 5_000;
const MAX_PLATFORM_ROWS_PER_WINDOW = MAX_ROWS_PER_SYNC * 2;

const vendorValidator = v.union(v.literal("vercel"), v.literal("convex"));
const costStatusValidator = v.union(
  v.literal("billed"),
  v.literal("estimated"),
  v.literal("metered"),
);

const rowValidator = v.object({
  day: v.string(),
  serviceName: v.string(),
  serviceCategory: v.string(),
  chargeCategory: v.optional(v.string()),
  billingCurrency: v.optional(v.string()),
  costStatus: costStatusValidator,
  billedCostDollars: v.optional(v.number()),
  effectiveCostDollars: v.optional(v.number()),
  usageQuantity: v.optional(v.number()),
  usageUnit: v.optional(v.string()),
  sourcePeriodStart: v.string(),
  sourcePeriodEnd: v.string(),
  sourceChargeCount: v.optional(v.number()),
});

type Vendor = "vercel" | "convex";
type CostStatus = "billed" | "estimated" | "metered";
type PlatformCostRow = {
  day: string;
  serviceName: string;
  serviceCategory: string;
  chargeCategory?: string;
  billingCurrency?: string;
  costStatus: CostStatus;
  billedCostDollars?: number;
  effectiveCostDollars?: number;
  usageQuantity?: number;
  usageUnit?: string;
  sourcePeriodStart: string;
  sourcePeriodEnd: string;
  sourceChargeCount?: number;
};

function assertUtcDay(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} must be a UTC date in YYYY-MM-DD format`);
  }
}

function assertFiniteOptional(value: number | undefined, field: string) {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new Error(`${field} must be finite`);
  }
}

function entityId(vendor: Vendor, row: PlatformCostRow) {
  return `platform:${JSON.stringify([
    vendor,
    row.serviceName,
    row.serviceCategory,
    row.chargeCategory ?? "",
    row.billingCurrency ?? "",
    row.usageUnit ?? "",
  ])}`;
}

function toStoredRow(vendor: Vendor, row: PlatformCostRow, observedAt: number) {
  const billedCost = row.billedCostDollars ?? 0;
  const recognizedCost = row.costStatus === "metered" ? 0 : billedCost;

  return {
    entity_type: "platform" as const,
    entity_id: entityId(vendor, row),
    vendor,
    service_name: row.serviceName,
    service_category: row.serviceCategory,
    charge_category: row.chargeCategory,
    billing_currency: row.billingCurrency,
    cost_status: row.costStatus,
    billed_cost_dollars: row.billedCostDollars,
    effective_cost_dollars: row.effectiveCostDollars,
    usage_quantity: row.usageQuantity,
    usage_unit: row.usageUnit,
    source_period_start: row.sourcePeriodStart,
    source_period_end: row.sourcePeriodEnd,
    source_observed_at: observedAt,
    source_charge_count: row.sourceChargeCount,
    day: row.day,
    gross_revenue_dollars: 0,
    net_revenue_dollars: 0,
    model_cost_dollars: 0,
    non_model_cost_dollars: recognizedCost,
    total_cost_dollars: recognizedCost,
    gross_profit_dollars: recognizedCost === 0 ? 0 : -recognizedCost,
    included_usage_cost_dollars: 0,
    extra_usage_cost_dollars: 0,
    usage_request_count: 0,
    revenue_event_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
    updated_at: observedAt,
  };
}

function materiallyEqual(existing: Record<string, unknown>, next: object) {
  return Object.entries(next).every(([key, value]) => {
    if (key === "source_observed_at" || key === "updated_at") return true;
    return existing[key] === value;
  });
}

/**
 * Replaces a bounded vendor/day window so retries, overlapping cron runs, and
 * provider-side billing corrections remain idempotent in PostHog's warehouse.
 */
export const replaceVendorCostWindow = mutation({
  args: {
    serviceKey: v.string(),
    vendor: vendorValidator,
    startDay: v.string(),
    endDay: v.string(),
    observedAt: v.number(),
    rows: v.array(rowValidator),
  },
  returns: v.object({
    inserted: v.number(),
    updated: v.number(),
    deleted: v.number(),
    unchanged: v.number(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    assertUtcDay(args.startDay, "startDay");
    assertUtcDay(args.endDay, "endDay");
    if (args.startDay > args.endDay) {
      throw new Error("startDay must be on or before endDay");
    }
    if (!Number.isFinite(args.observedAt)) {
      throw new Error("observedAt must be finite");
    }
    if (args.rows.length > MAX_ROWS_PER_SYNC) {
      throw new Error(`rows must contain at most ${MAX_ROWS_PER_SYNC} items`);
    }

    const incoming = new Map<string, ReturnType<typeof toStoredRow>>();
    for (const row of args.rows) {
      assertUtcDay(row.day, "row.day");
      if (row.day < args.startDay || row.day > args.endDay) {
        throw new Error("row.day must be inside the replacement window");
      }
      if (!row.serviceName.trim() || !row.serviceCategory.trim()) {
        throw new Error("serviceName and serviceCategory must not be empty");
      }
      assertFiniteOptional(row.billedCostDollars, "billedCostDollars");
      assertFiniteOptional(row.effectiveCostDollars, "effectiveCostDollars");
      assertFiniteOptional(row.usageQuantity, "usageQuantity");
      assertFiniteOptional(row.sourceChargeCount, "sourceChargeCount");
      if (row.costStatus === "metered" && row.billedCostDollars !== undefined) {
        throw new Error("metered rows must not include billedCostDollars");
      }

      const stored = toStoredRow(args.vendor as Vendor, row, args.observedAt);
      const key = `${stored.day}\u0000${stored.entity_id}`;
      if (incoming.has(key)) {
        throw new Error("rows contain a duplicate day and service identity");
      }
      incoming.set(key, stored);
    }

    const platformRows = await ctx.db
      .query("unit_economics_daily")
      .withIndex("by_type_day", (q) =>
        q
          .eq("entity_type", "platform")
          .gte("day", args.startDay)
          .lte("day", args.endDay),
      )
      .take(MAX_PLATFORM_ROWS_PER_WINDOW + 1);
    if (platformRows.length > MAX_PLATFORM_ROWS_PER_WINDOW) {
      throw new Error(
        "existing platform rows exceed the safe replacement limit",
      );
    }
    const existing = platformRows.filter((row) => row.vendor === args.vendor);

    let inserted = 0;
    let updated = 0;
    let deleted = 0;
    let unchanged = 0;

    for (const row of existing) {
      const key = `${row.day}\u0000${row.entity_id}`;
      const next = incoming.get(key);
      if (!next) {
        await ctx.db.delete(row._id);
        deleted += 1;
        continue;
      }

      incoming.delete(key);
      if (materiallyEqual(row, next)) {
        unchanged += 1;
      } else {
        await ctx.db.patch(row._id, next);
        updated += 1;
      }
    }

    for (const row of incoming.values()) {
      await ctx.db.insert("unit_economics_daily", row);
      inserted += 1;
    }

    return { inserted, updated, deleted, unchanged };
  },
});
