import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";
import {
  applyUnitEconomicsDelta,
  LEGACY_USAGE_COST_MULTIPLIER,
  utcDay,
} from "./unitEconomicsLib";

const typeValidator = v.union(
  v.literal("included"),
  v.literal("extra"),
  v.literal("mixed"),
);

const cleanModelName = (model: string): string =>
  model
    .replace(/^model-/, "")
    .replace(/^fallback-/, "")
    .replace(/-model$/, "")
    .replace(/^[a-z-]+\//, "")
    .replace(/-\d{8}$/, "");

/**
 * Insert a usage log record (called from backend after each request).
 */
export const logUsage = mutation({
  args: {
    serviceKey: v.string(),
    user_id: v.string(),
    organization_id: v.optional(v.string()),
    chat_id: v.optional(v.string()),
    endpoint: v.optional(
      v.union(v.literal("/api/chat"), v.literal("/api/agent-long")),
    ),
    mode: v.optional(v.union(v.literal("ask"), v.literal("agent"))),
    subscription: v.optional(v.string()),
    model: v.string(),
    type: typeValidator,
    input_tokens: v.number(),
    output_tokens: v.number(),
    cache_read_tokens: v.optional(v.number()),
    cache_write_tokens: v.optional(v.number()),
    total_tokens: v.number(),
    cost_dollars: v.number(),
    included_cost_dollars: v.optional(v.number()),
    extra_usage_cost_dollars: v.optional(v.number()),
    uncovered_cost_dollars: v.optional(v.number()),
    included_points_deducted: v.optional(v.number()),
    extra_usage_points_deducted: v.optional(v.number()),
    uncovered_points: v.optional(v.number()),
    usage_deduction_failed: v.optional(v.boolean()),
    usage_deduction_failure_reason: v.optional(v.string()),
    model_cost_dollars: v.optional(v.number()),
    non_model_cost_dollars: v.optional(v.number()),
    cost_source: v.optional(
      v.union(
        v.literal("provider"),
        v.literal("token_estimate"),
        v.literal("raw_token_estimate"),
      ),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const nonModelCostDollars = Number.isFinite(args.non_model_cost_dollars)
      ? args.non_model_cost_dollars!
      : 0;
    const reportedModelCostDollars = Number.isFinite(args.model_cost_dollars)
      ? args.model_cost_dollars!
      : Math.max(0, args.cost_dollars - nonModelCostDollars);
    // Older app builds sent token_estimate costs after applying the 1.3 usage
    // multiplier. Normalize those at ingestion so unit economics tracks raw
    // model cost even during staggered deploys.
    const modelCostDollars =
      args.cost_source === "token_estimate"
        ? reportedModelCostDollars / LEGACY_USAGE_COST_MULTIPLIER
        : reportedModelCostDollars;
    const costDollars = modelCostDollars + nonModelCostDollars;
    const reportedCostDollars = reportedModelCostDollars + nonModelCostDollars;
    const costBreakdownScale =
      args.cost_source === "token_estimate" && reportedCostDollars > 0
        ? costDollars / reportedCostDollars
        : 1;
    const includedCostDollars = Number.isFinite(args.included_cost_dollars)
      ? args.included_cost_dollars! * costBreakdownScale
      : undefined;
    const extraCostDollars = Number.isFinite(args.extra_usage_cost_dollars)
      ? args.extra_usage_cost_dollars! * costBreakdownScale
      : undefined;
    const uncoveredCostDollars = Number.isFinite(args.uncovered_cost_dollars)
      ? args.uncovered_cost_dollars! * costBreakdownScale
      : undefined;

    if (
      args.type === "mixed" &&
      (includedCostDollars === undefined || extraCostDollars === undefined)
    ) {
      throw new Error(
        "Mixed usage logs require included and extra usage cost breakdowns",
      );
    }

    const includedUsageCostDollars =
      includedCostDollars !== undefined
        ? includedCostDollars
        : args.type === "included"
          ? costDollars
          : 0;
    const extraUsageCostDollars =
      extraCostDollars !== undefined
        ? extraCostDollars
        : args.type === "extra"
          ? costDollars
          : 0;
    const uncoveredUsageCostDollars = uncoveredCostDollars ?? 0;
    const costSource =
      args.cost_source === "token_estimate"
        ? "raw_token_estimate"
        : args.cost_source;
    const now = Date.now();

    await ctx.db.insert("usage_logs", {
      user_id: args.user_id,
      organization_id: args.organization_id,
      chat_id: args.chat_id,
      endpoint: args.endpoint,
      mode: args.mode,
      subscription: args.subscription,
      model: args.model,
      type: args.type,
      input_tokens: args.input_tokens,
      output_tokens: args.output_tokens,
      cache_read_tokens: args.cache_read_tokens,
      cache_write_tokens: args.cache_write_tokens,
      total_tokens: args.total_tokens,
      cost_dollars: costDollars,
      included_cost_dollars: includedUsageCostDollars,
      extra_usage_cost_dollars: extraUsageCostDollars,
      uncovered_cost_dollars: uncoveredUsageCostDollars,
      included_points_deducted: args.included_points_deducted,
      extra_usage_points_deducted: args.extra_usage_points_deducted,
      uncovered_points: args.uncovered_points,
      usage_deduction_failed:
        args.usage_deduction_failed === true ||
        (args.uncovered_points ?? 0) > 0,
      usage_deduction_failure_reason: args.usage_deduction_failure_reason,
      model_cost_dollars: modelCostDollars,
      non_model_cost_dollars: nonModelCostDollars,
      cost_source: costSource,
    });

    const commonDelta = {
      day: utcDay(now),
      modelCostDollars,
      nonModelCostDollars,
      includedUsageCostDollars,
      extraUsageCostDollars,
      usageRequestCount: 1,
      inputTokens: args.input_tokens,
      outputTokens: args.output_tokens,
      cacheReadTokens: args.cache_read_tokens ?? 0,
      cacheWriteTokens: args.cache_write_tokens ?? 0,
      totalTokens: args.total_tokens,
    };

    await applyUnitEconomicsDelta(ctx, {
      ...commonDelta,
      entityType: "user",
      entityId: args.user_id,
      userId: args.user_id,
      organizationId: args.organization_id,
    });

    if (args.organization_id) {
      await applyUnitEconomicsDelta(ctx, {
        ...commonDelta,
        entityType: "organization",
        entityId: args.organization_id,
        organizationId: args.organization_id,
      });
    }

    return null;
  },
});

/**
 * Daily usage cost aggregates for the last N days (default 7).
 * Used for projected exhaustion date calculation.
 */
export const getDailyUsageSummary = query({
  args: {
    days: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthenticated");
    }
    const userId = identity.subject;
    const days = Math.min(Math.max(Math.round(args.days ?? 7), 1), 30);

    // Aggregate by day (UTC), zero-filling missing days
    const dailyMap = new Map<string, number>();
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      dailyMap.set(d.toISOString().slice(0, 10), 0);
    }

    const dayKeys = Array.from(dailyMap.keys());
    const rollups = await ctx.db
      .query("unit_economics_daily")
      .withIndex("by_user_day", (q) =>
        q
          .eq("user_id", userId)
          .gte("day", dayKeys[0])
          .lte("day", dayKeys[dayKeys.length - 1]),
      )
      .collect();

    for (const row of rollups) {
      dailyMap.set(
        row.day,
        row.included_usage_cost_dollars + row.extra_usage_cost_dollars,
      );
    }

    return Array.from(dailyMap.entries())
      .map(([date, costDollars]) => ({ date, costDollars }))
      .sort((a, b) => a.date.localeCompare(b.date));
  },
});

/**
 * Paginated usage logs for the authenticated user within a date range.
 * Uses Convex cursor-based pagination via usePaginatedQuery on the client.
 */
export const getUserUsageLogs = query({
  args: {
    paginationOpts: paginationOptsValidator,
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthenticated");
    }
    const userId = identity.subject;

    const results = await ctx.db
      .query("usage_logs")
      .withIndex("by_user", (q) =>
        q
          .eq("user_id", userId)
          .gte("_creationTime", args.startDate)
          .lte("_creationTime", args.endDate),
      )
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...results,
      page: results.page.map((log) => ({
        _id: log._id,
        _creationTime: log._creationTime,
        model: cleanModelName(log.model),
        type: log.type as "included" | "extra" | "mixed",
        input_tokens: log.input_tokens,
        output_tokens: log.output_tokens,
        cache_read_tokens: log.cache_read_tokens,
        cache_write_tokens: log.cache_write_tokens,
        total_tokens: log.total_tokens,
        cost_dollars: log.cost_dollars,
        included_cost_dollars:
          log.included_cost_dollars ??
          (log.type === "included" ? log.cost_dollars : 0),
        extra_usage_cost_dollars:
          log.extra_usage_cost_dollars ??
          (log.type === "extra" ? log.cost_dollars : 0),
        uncovered_cost_dollars: log.uncovered_cost_dollars ?? 0,
        included_points_deducted: log.included_points_deducted,
        extra_usage_points_deducted: log.extra_usage_points_deducted,
        uncovered_points: log.uncovered_points,
        usage_deduction_failed: log.usage_deduction_failed,
        usage_deduction_failure_reason: log.usage_deduction_failure_reason,
        model_cost_dollars: log.model_cost_dollars,
        non_model_cost_dollars: log.non_model_cost_dollars,
        cost_source: log.cost_source,
      })),
    };
  },
});
