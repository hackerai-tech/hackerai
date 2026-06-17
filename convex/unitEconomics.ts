import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";
import {
  applyPaidStartMixDelta,
  applyUnitEconomicsDelta,
  LEGACY_USAGE_COST_MULTIPLIER,
  recordPaidStartEventInternal,
  recordRevenueEventInternal,
  utcDay,
  type PaidStartBillingInterval,
  type PaidStartConversionType,
  type PaidStartMixBillingInterval,
  type PaidStartTier,
  type UnitEconomicsAttributionStrategy,
  type UnitEconomicsEntityType,
  type UnitEconomicsRevenueSource,
} from "./unitEconomicsLib";

const entityTypeValidator = v.union(
  v.literal("user"),
  v.literal("organization"),
);

const revenueSourceValidator = v.union(
  v.literal("subscription"),
  v.literal("extra_usage"),
  v.literal("team_extra_usage"),
  v.literal("manual_adjustment"),
);

const attributionStrategyValidator = v.union(
  v.literal("direct"),
  v.literal("split_evenly"),
  v.literal("organization_pool"),
);

const paidStartTierValidator = v.union(
  v.literal("pro"),
  v.literal("pro-plus"),
  v.literal("ultra"),
  v.literal("team"),
);

const paidStartBillingIntervalValidator = v.union(
  v.literal("day"),
  v.literal("week"),
  v.literal("month"),
  v.literal("year"),
);

const paidStartMixBillingIntervalValidator = v.union(
  v.literal("day"),
  v.literal("week"),
  v.literal("month"),
  v.literal("year"),
  v.literal("unknown"),
);

const paidStartConversionTypeValidator = v.union(
  v.literal("free_to_paid"),
  v.literal("paid_subscription_start"),
);

export const UNIT_ECONOMICS_REPORTING_START_DAY = "2026-05-31";
const UNIT_ECONOMICS_REPORTING_START_TIME = Date.parse(
  `${UNIT_ECONOMICS_REPORTING_START_DAY}T00:00:00.000Z`,
);

function reportingStartDay(startDay: string, includeHistorical?: boolean) {
  if (includeHistorical) return startDay;
  return startDay < UNIT_ECONOMICS_REPORTING_START_DAY
    ? UNIT_ECONOMICS_REPORTING_START_DAY
    : startDay;
}

function reportingStartTime(startTime: number, includeHistorical?: boolean) {
  if (includeHistorical) return startTime;
  return Math.max(startTime, UNIT_ECONOMICS_REPORTING_START_TIME);
}

function assertFiniteMoney(value: number, field: string) {
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be finite`);
  }
}

function assertFiniteOptionalNumber(value: number | undefined, field: string) {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new Error(`${field} must be finite`);
  }
}

function sumRows(rows: Array<any>) {
  return rows.reduce(
    (totals, row) => ({
      grossRevenueDollars:
        totals.grossRevenueDollars + row.gross_revenue_dollars,
      netRevenueDollars: totals.netRevenueDollars + row.net_revenue_dollars,
      mrrDollars: totals.mrrDollars + (row.mrr_dollars ?? 0),
      modelCostDollars: totals.modelCostDollars + row.model_cost_dollars,
      nonModelCostDollars:
        totals.nonModelCostDollars + row.non_model_cost_dollars,
      totalCostDollars: totals.totalCostDollars + row.total_cost_dollars,
      grossProfitDollars: totals.grossProfitDollars + row.gross_profit_dollars,
      includedUsageCostDollars:
        totals.includedUsageCostDollars + row.included_usage_cost_dollars,
      extraUsageCostDollars:
        totals.extraUsageCostDollars + row.extra_usage_cost_dollars,
      usageRequestCount: totals.usageRequestCount + row.usage_request_count,
      revenueEventCount: totals.revenueEventCount + row.revenue_event_count,
      inputTokens: totals.inputTokens + row.input_tokens,
      outputTokens: totals.outputTokens + row.output_tokens,
      cacheReadTokens: totals.cacheReadTokens + row.cache_read_tokens,
      cacheWriteTokens: totals.cacheWriteTokens + row.cache_write_tokens,
      totalTokens: totals.totalTokens + row.total_tokens,
    }),
    {
      grossRevenueDollars: 0,
      netRevenueDollars: 0,
      mrrDollars: 0,
      modelCostDollars: 0,
      nonModelCostDollars: 0,
      totalCostDollars: 0,
      grossProfitDollars: 0,
      includedUsageCostDollars: 0,
      extraUsageCostDollars: 0,
      usageRequestCount: 0,
      revenueEventCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
  );
}

export const recordRevenueEvent = mutation({
  args: {
    serviceKey: v.string(),
    entityType: entityTypeValidator,
    entityId: v.string(),
    userId: v.optional(v.string()),
    organizationId: v.optional(v.string()),
    source: revenueSourceValidator,
    sourceEventId: v.string(),
    idempotencyKey: v.optional(v.string()),
    grossRevenueDollars: v.number(),
    netRevenueDollars: v.optional(v.number()),
    mrrDollars: v.optional(v.number()),
    currency: v.optional(v.string()),
    occurredAt: v.optional(v.number()),
    attributionStrategy: attributionStrategyValidator,
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    stripeInvoiceId: v.optional(v.string()),
    stripeCheckoutSessionId: v.optional(v.string()),
    stripePaymentIntentId: v.optional(v.string()),
    stripePriceId: v.optional(v.string()),
    plan: v.optional(v.string()),
    quantity: v.optional(v.number()),
    userCount: v.optional(v.number()),
    description: v.optional(v.string()),
  },
  returns: v.object({
    alreadyRecorded: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    assertFiniteMoney(args.grossRevenueDollars, "grossRevenueDollars");
    if (args.netRevenueDollars !== undefined) {
      assertFiniteMoney(args.netRevenueDollars, "netRevenueDollars");
    }
    if (args.mrrDollars !== undefined) {
      assertFiniteMoney(args.mrrDollars, "mrrDollars");
    }

    return await recordRevenueEventInternal(ctx, {
      entityType: args.entityType as UnitEconomicsEntityType,
      entityId: args.entityId,
      userId: args.userId,
      organizationId: args.organizationId,
      source: args.source as UnitEconomicsRevenueSource,
      sourceEventId: args.sourceEventId,
      idempotencyKey: args.idempotencyKey,
      grossRevenueDollars: args.grossRevenueDollars,
      netRevenueDollars: args.netRevenueDollars,
      mrrDollars: args.mrrDollars,
      currency: args.currency,
      occurredAt: args.occurredAt,
      attributionStrategy:
        args.attributionStrategy as UnitEconomicsAttributionStrategy,
      stripeCustomerId: args.stripeCustomerId,
      stripeSubscriptionId: args.stripeSubscriptionId,
      stripeInvoiceId: args.stripeInvoiceId,
      stripeCheckoutSessionId: args.stripeCheckoutSessionId,
      stripePaymentIntentId: args.stripePaymentIntentId,
      stripePriceId: args.stripePriceId,
      plan: args.plan,
      quantity: args.quantity,
      userCount: args.userCount,
      description: args.description,
    });
  },
});

export const recordPaidStartEvent = mutation({
  args: {
    serviceKey: v.string(),
    entityType: entityTypeValidator,
    entityId: v.string(),
    userId: v.optional(v.string()),
    organizationId: v.optional(v.string()),
    sourceEventId: v.string(),
    idempotencyKey: v.optional(v.string()),
    occurredAt: v.optional(v.number()),
    conversionType: paidStartConversionTypeValidator,
    tier: paidStartTierValidator,
    plan: v.optional(v.string()),
    paidAccountStartCount: v.optional(v.number()),
    paidUserStartCount: v.optional(v.number()),
    paidSeatCount: v.optional(v.number()),
    billingInterval: v.optional(paidStartBillingIntervalValidator),
    billingIntervalCount: v.optional(v.number()),
    quantity: v.optional(v.number()),
    userCount: v.optional(v.number()),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    stripeInvoiceId: v.optional(v.string()),
    stripePriceId: v.optional(v.string()),
  },
  returns: v.object({
    alreadyRecorded: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    assertFiniteOptionalNumber(args.occurredAt, "occurredAt");
    assertFiniteOptionalNumber(
      args.paidAccountStartCount,
      "paidAccountStartCount",
    );
    assertFiniteOptionalNumber(args.paidUserStartCount, "paidUserStartCount");
    assertFiniteOptionalNumber(args.paidSeatCount, "paidSeatCount");
    assertFiniteOptionalNumber(
      args.billingIntervalCount,
      "billingIntervalCount",
    );
    assertFiniteOptionalNumber(args.quantity, "quantity");
    assertFiniteOptionalNumber(args.userCount, "userCount");

    return await recordPaidStartEventInternal(ctx, {
      entityType: args.entityType as UnitEconomicsEntityType,
      entityId: args.entityId,
      userId: args.userId,
      organizationId: args.organizationId,
      sourceEventId: args.sourceEventId,
      idempotencyKey: args.idempotencyKey,
      occurredAt: args.occurredAt,
      conversionType: args.conversionType as PaidStartConversionType,
      tier: args.tier as PaidStartTier,
      plan: args.plan,
      paidAccountStartCount: args.paidAccountStartCount,
      paidUserStartCount: args.paidUserStartCount,
      paidSeatCount: args.paidSeatCount,
      billingInterval: args.billingInterval as
        | PaidStartBillingInterval
        | undefined,
      billingIntervalCount: args.billingIntervalCount,
      quantity: args.quantity,
      userCount: args.userCount,
      stripeCustomerId: args.stripeCustomerId,
      stripeSubscriptionId: args.stripeSubscriptionId,
      stripeInvoiceId: args.stripeInvoiceId,
      stripePriceId: args.stripePriceId,
    });
  },
});

export const getEntitySummary = query({
  args: {
    serviceKey: v.string(),
    entityType: entityTypeValidator,
    entityId: v.string(),
    startDay: v.optional(v.string()),
    endDay: v.optional(v.string()),
    includeHistorical: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const startDay = reportingStartDay(
      args.startDay ?? UNIT_ECONOMICS_REPORTING_START_DAY,
      args.includeHistorical,
    );
    const endDay = args.endDay ?? "9999-99-99";
    if (startDay > endDay) {
      return {
        entityType: args.entityType,
        entityId: args.entityId,
        startDay,
        endDay,
        totals: sumRows([]),
        days: [],
      };
    }

    const rows = await ctx.db
      .query("unit_economics_daily")
      .withIndex("by_entity_day", (q) =>
        q
          .eq("entity_type", args.entityType)
          .eq("entity_id", args.entityId)
          .gte("day", startDay)
          .lte("day", endDay),
      )
      .collect();

    return {
      entityType: args.entityType,
      entityId: args.entityId,
      startDay,
      endDay,
      totals: sumRows(rows),
      days: rows.sort((a, b) => a.day.localeCompare(b.day)),
    };
  },
});

export const rebuildEntityDailyRollups = mutation({
  args: {
    serviceKey: v.string(),
    entityType: entityTypeValidator,
    entityId: v.string(),
    startTime: v.optional(v.number()),
    endTime: v.optional(v.number()),
    maxRows: v.optional(v.number()),
    includeHistorical: v.optional(v.boolean()),
  },
  returns: v.object({
    deletedRollups: v.number(),
    usageRowsApplied: v.number(),
    revenueRowsApplied: v.number(),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const startTime = reportingStartTime(
      args.startTime ?? UNIT_ECONOMICS_REPORTING_START_TIME,
      args.includeHistorical,
    );
    const endTime = args.endTime ?? Date.now();
    const maxRows = Math.min(
      Math.max(Math.round(args.maxRows ?? 5000), 1),
      10_000,
    );
    const startDay = utcDay(startTime);
    const endDay = utcDay(endTime);

    if (startTime > endTime) {
      return {
        deletedRollups: 0,
        usageRowsApplied: 0,
        revenueRowsApplied: 0,
        truncated: false,
      };
    }

    const existingRollups = await ctx.db
      .query("unit_economics_daily")
      .withIndex("by_entity_day", (q) =>
        q
          .eq("entity_type", args.entityType)
          .eq("entity_id", args.entityId)
          .gte("day", startDay)
          .lte("day", endDay),
      )
      .take(maxRows);

    for (const row of existingRollups) {
      await ctx.db.delete(row._id);
    }

    if (existingRollups.length === maxRows) {
      return {
        deletedRollups: existingRollups.length,
        usageRowsApplied: 0,
        revenueRowsApplied: 0,
        truncated: true,
      };
    }

    const usageRows =
      args.entityType === "user"
        ? await ctx.db
            .query("usage_logs")
            .withIndex("by_user", (q) =>
              q
                .eq("user_id", args.entityId)
                .gte("_creationTime", startTime)
                .lte("_creationTime", endTime),
            )
            .take(maxRows)
        : await ctx.db
            .query("usage_logs")
            .withIndex("by_org", (q) =>
              q
                .eq("organization_id", args.entityId)
                .gte("_creationTime", startTime)
                .lte("_creationTime", endTime),
            )
            .take(maxRows);

    for (const log of usageRows) {
      const nonModelCostDollars = log.non_model_cost_dollars ?? 0;
      const reportedModelCostDollars =
        log.model_cost_dollars ??
        Math.max(0, log.cost_dollars - nonModelCostDollars);
      const modelCostDollars =
        log.cost_source === "token_estimate"
          ? reportedModelCostDollars / LEGACY_USAGE_COST_MULTIPLIER
          : reportedModelCostDollars;
      const costDollars = modelCostDollars + nonModelCostDollars;
      await applyUnitEconomicsDelta(ctx, {
        entityType: args.entityType as UnitEconomicsEntityType,
        entityId: args.entityId,
        userId: args.entityType === "user" ? args.entityId : undefined,
        organizationId:
          args.entityType === "organization"
            ? args.entityId
            : log.organization_id,
        day: utcDay(log._creationTime),
        modelCostDollars,
        nonModelCostDollars,
        includedUsageCostDollars: log.type === "included" ? costDollars : 0,
        extraUsageCostDollars: log.type === "extra" ? costDollars : 0,
        usageRequestCount: 1,
        inputTokens: log.input_tokens,
        outputTokens: log.output_tokens,
        cacheReadTokens: log.cache_read_tokens ?? 0,
        cacheWriteTokens: log.cache_write_tokens ?? 0,
        totalTokens: log.total_tokens,
      });
    }

    const revenueRows = await ctx.db
      .query("revenue_events")
      .withIndex("by_entity_occurred", (q) =>
        q
          .eq("entity_type", args.entityType)
          .eq("entity_id", args.entityId)
          .gte("occurred_at", startTime)
          .lte("occurred_at", endTime),
      )
      .take(maxRows);

    for (const event of revenueRows) {
      await applyUnitEconomicsDelta(ctx, {
        entityType: args.entityType as UnitEconomicsEntityType,
        entityId: args.entityId,
        userId: event.user_id,
        organizationId: event.organization_id,
        day: utcDay(event.occurred_at),
        grossRevenueDollars: event.gross_revenue_dollars,
        netRevenueDollars: event.net_revenue_dollars,
        mrrDollars: event.mrr_dollars,
        revenueEventCount: 1,
      });
    }

    return {
      deletedRollups: existingRollups.length,
      usageRowsApplied: usageRows.length,
      revenueRowsApplied: revenueRows.length,
      truncated: usageRows.length === maxRows || revenueRows.length === maxRows,
    };
  },
});

export const rebuildPaidStartMixDailyRollups = mutation({
  args: {
    serviceKey: v.string(),
    startDay: v.string(),
    endDay: v.string(),
    maxRows: v.optional(v.number()),
  },
  returns: v.object({
    deletedRollups: v.number(),
    eventRowsApplied: v.number(),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const maxRows = Math.min(
      Math.max(Math.round(args.maxRows ?? 5000), 1),
      10_000,
    );

    const existingRollups = await ctx.db
      .query("paid_start_mix_daily")
      .withIndex("by_day", (q) =>
        q.gte("day", args.startDay).lte("day", args.endDay),
      )
      .take(maxRows);

    for (const row of existingRollups) {
      await ctx.db.delete(row._id);
    }

    if (existingRollups.length === maxRows) {
      return {
        deletedRollups: existingRollups.length,
        eventRowsApplied: 0,
        truncated: true,
      };
    }

    const events = await ctx.db
      .query("paid_start_events")
      .withIndex("by_day", (q) =>
        q.gte("day", args.startDay).lte("day", args.endDay),
      )
      .take(maxRows);

    for (const event of events) {
      await applyPaidStartMixDelta(ctx, {
        day: event.day,
        tier: event.tier as PaidStartTier,
        plan: event.plan ?? event.tier,
        billingInterval:
          (event.billing_interval as PaidStartMixBillingInterval | undefined) ??
          "unknown",
        paidAccountStartCount: event.paid_account_start_count,
        paidUserStartCount: event.paid_user_start_count,
        paidSeatCount: event.paid_seat_count,
      });
    }

    return {
      deletedRollups: existingRollups.length,
      eventRowsApplied: events.length,
      truncated: events.length === maxRows,
    };
  },
});

export const listDailyRollupsForPostHog = query({
  args: {
    serviceKey: v.string(),
    startDay: v.string(),
    endDay: v.string(),
    entityType: v.optional(entityTypeValidator),
    limit: v.optional(v.number()),
    includeHistorical: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const limit = Math.min(Math.max(Math.round(args.limit ?? 1000), 1), 5000);
    const startDay = reportingStartDay(args.startDay, args.includeHistorical);
    if (startDay > args.endDay) {
      return [];
    }

    const query = ctx.db
      .query("unit_economics_daily")
      .withIndex("by_day", (q) =>
        q.gte("day", startDay).lte("day", args.endDay),
      );
    const rows = args.entityType
      ? await query
          .filter((q) => q.eq(q.field("entity_type"), args.entityType))
          .take(limit)
      : await query.take(limit);

    return rows.sort((a, b) => {
      const dayCompare = a.day.localeCompare(b.day);
      if (dayCompare !== 0) return dayCompare;
      return `${a.entity_type}:${a.entity_id}`.localeCompare(
        `${b.entity_type}:${b.entity_id}`,
      );
    });
  },
});

export const listPaidStartMixForPostHog = query({
  args: {
    serviceKey: v.string(),
    startDay: v.string(),
    endDay: v.string(),
    tier: v.optional(paidStartTierValidator),
    billingInterval: v.optional(paidStartMixBillingIntervalValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const limit = Math.min(Math.max(Math.round(args.limit ?? 1000), 1), 5000);
    const rows =
      args.tier && args.billingInterval
        ? await ctx.db
            .query("paid_start_mix_daily")
            .withIndex("by_tier_interval_day", (q) =>
              q
                .eq("tier", args.tier!)
                .eq("billing_interval", args.billingInterval!)
                .gte("day", args.startDay)
                .lte("day", args.endDay),
            )
            .take(limit)
        : args.tier
          ? await ctx.db
              .query("paid_start_mix_daily")
              .withIndex("by_tier_day", (q) =>
                q
                  .eq("tier", args.tier!)
                  .gte("day", args.startDay)
                  .lte("day", args.endDay),
              )
              .take(limit)
          : args.billingInterval
            ? await ctx.db
                .query("paid_start_mix_daily")
                .withIndex("by_interval_day", (q) =>
                  q
                    .eq("billing_interval", args.billingInterval!)
                    .gte("day", args.startDay)
                    .lte("day", args.endDay),
                )
                .take(limit)
            : await ctx.db
                .query("paid_start_mix_daily")
                .withIndex("by_day", (q) =>
                  q.gte("day", args.startDay).lte("day", args.endDay),
                )
                .take(limit);

    return rows.sort((a, b) => {
      const dayCompare = a.day.localeCompare(b.day);
      if (dayCompare !== 0) return dayCompare;
      const tierCompare = a.tier.localeCompare(b.tier);
      if (tierCompare !== 0) return tierCompare;
      const intervalCompare = a.billing_interval.localeCompare(
        b.billing_interval,
      );
      if (intervalCompare !== 0) return intervalCompare;
      return a.plan.localeCompare(b.plan);
    });
  },
});
