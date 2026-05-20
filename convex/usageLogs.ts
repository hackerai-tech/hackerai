import { internalMutation, mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";

const typeValidator = v.union(v.literal("included"), v.literal("extra"));
const subscriptionTierValidator = v.union(
  v.literal("free"),
  v.literal("pro"),
  v.literal("pro-plus"),
  v.literal("ultra"),
  v.literal("team"),
);
const modeValidator = v.union(
  v.literal("ask"),
  v.literal("agent"),
  v.literal("agent-long"),
);

const cleanModelName = (model: string): string =>
  model
    .replace(/^model-/, "")
    .replace(/^fallback-/, "")
    .replace(/-model$/, "")
    .replace(/^[a-z-]+\//, "")
    .replace(/-\d{8}$/, "");

const dayFromMs = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 10);

async function upsertAccountForUsage(
  ctx: any,
  userId: string,
  subscriptionTier: "free" | "pro" | "pro-plus" | "ultra" | "team",
) {
  const now = Date.now();
  const existing = await ctx.db
    .query("user_accounts")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .unique();

  if (!existing) {
    await ctx.db.insert("user_accounts", {
      user_id: userId,
      first_seen_at: now,
      last_seen_at: now,
      current_subscription_tier: subscriptionTier,
      ...(subscriptionTier !== "free" && { first_paid_at: now }),
      updated_at: now,
    });
    return;
  }

  await ctx.db.patch(existing._id, {
    last_seen_at: now,
    current_subscription_tier: subscriptionTier,
    ...(subscriptionTier !== "free" &&
      !existing.first_paid_at && { first_paid_at: now }),
    updated_at: now,
  });
}

async function aggregateUsageDaily(
  ctx: any,
  args: {
    user_id: string;
    subscription_tier: "free" | "pro" | "pro-plus" | "ultra" | "team";
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    model_cost_dollars: number;
    non_model_cost_dollars: number;
    cost_dollars: number;
  },
) {
  const now = Date.now();
  const day = dayFromMs(now);
  const existing = await ctx.db
    .query("user_economics_daily")
    .withIndex("by_day_user_tier", (q: any) =>
      q
        .eq("day", day)
        .eq("user_id", args.user_id)
        .eq("subscription_tier", args.subscription_tier),
    )
    .unique();

  if (!existing) {
    await ctx.db.insert("user_economics_daily", {
      day,
      user_id: args.user_id,
      subscription_tier: args.subscription_tier,
      request_count: 1,
      input_tokens: args.input_tokens,
      output_tokens: args.output_tokens,
      total_tokens: args.total_tokens,
      llm_cost_dollars: args.model_cost_dollars,
      tool_cost_dollars: args.non_model_cost_dollars,
      total_cost_dollars: args.cost_dollars,
      gross_revenue_dollars: 0,
      refund_dollars: 0,
      net_revenue_dollars: 0,
      updated_at: now,
    });
  } else {
    await ctx.db.patch(existing._id, {
      request_count: existing.request_count + 1,
      input_tokens: existing.input_tokens + args.input_tokens,
      output_tokens: existing.output_tokens + args.output_tokens,
      total_tokens: existing.total_tokens + args.total_tokens,
      llm_cost_dollars: existing.llm_cost_dollars + args.model_cost_dollars,
      tool_cost_dollars:
        existing.tool_cost_dollars + args.non_model_cost_dollars,
      total_cost_dollars: existing.total_cost_dollars + args.cost_dollars,
      updated_at: now,
    });
  }

  await upsertAccountForUsage(ctx, args.user_id, args.subscription_tier);
}

/**
 * Insert a usage log record (called from backend after each request).
 */
export const logUsage = mutation({
  args: {
    serviceKey: v.string(),
    user_id: v.string(),
    subscription_tier: v.optional(subscriptionTierValidator),
    mode: v.optional(modeValidator),
    model: v.string(),
    type: typeValidator,
    input_tokens: v.number(),
    output_tokens: v.number(),
    cache_read_tokens: v.optional(v.number()),
    cache_write_tokens: v.optional(v.number()),
    total_tokens: v.number(),
    model_cost_dollars: v.optional(v.number()),
    non_model_cost_dollars: v.optional(v.number()),
    cost_dollars: v.number(),
    persist_raw_log: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const modelCostDollars = args.model_cost_dollars ?? args.cost_dollars;
    const nonModelCostDollars = args.non_model_cost_dollars ?? 0;

    if (args.persist_raw_log ?? true) {
      await ctx.db.insert("usage_logs", {
        user_id: args.user_id,
        subscription_tier: args.subscription_tier,
        mode: args.mode,
        model: args.model,
        type: args.type,
        input_tokens: args.input_tokens,
        output_tokens: args.output_tokens,
        cache_read_tokens: args.cache_read_tokens,
        cache_write_tokens: args.cache_write_tokens,
        total_tokens: args.total_tokens,
        model_cost_dollars: modelCostDollars,
        non_model_cost_dollars: nonModelCostDollars,
        cost_dollars: args.cost_dollars,
      });
    }

    if (args.subscription_tier) {
      await aggregateUsageDaily(ctx, {
        user_id: args.user_id,
        subscription_tier: args.subscription_tier,
        input_tokens: args.input_tokens,
        output_tokens: args.output_tokens,
        total_tokens: args.total_tokens,
        model_cost_dollars: modelCostDollars,
        non_model_cost_dollars: nonModelCostDollars,
        cost_dollars: args.cost_dollars,
      });
    }

    return null;
  },
});

export const purgeOldUsageLogs = internalMutation({
  args: {
    cutoffTimeMs: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.object({ deletedCount: v.number() }),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    const rows = await ctx.db.query("usage_logs").order("asc").take(limit);
    let deletedCount = 0;

    for (const row of rows) {
      if (row._creationTime >= args.cutoffTimeMs) break;
      await ctx.db.delete(row._id);
      deletedCount++;
    }

    return { deletedCount };
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
    const startDate = Date.now() - days * 24 * 60 * 60 * 1000;

    const logs = await ctx.db
      .query("usage_logs")
      .withIndex("by_user", (q) =>
        q.eq("user_id", userId).gte("_creationTime", startDate),
      )
      .collect();

    // Aggregate by day (UTC), zero-filling missing days
    const dailyMap = new Map<string, number>();
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      dailyMap.set(d.toISOString().slice(0, 10), 0);
    }
    for (const log of logs) {
      const day = new Date(log._creationTime).toISOString().slice(0, 10);
      dailyMap.set(day, (dailyMap.get(day) ?? 0) + log.cost_dollars);
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
        type: log.type as "included" | "extra",
        input_tokens: log.input_tokens,
        output_tokens: log.output_tokens,
        cache_read_tokens: log.cache_read_tokens,
        cache_write_tokens: log.cache_write_tokens,
        total_tokens: log.total_tokens,
        cost_dollars: log.cost_dollars,
      })),
    };
  },
});
