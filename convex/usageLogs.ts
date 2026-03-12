import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";

const typeValidator = v.union(v.literal("included"), v.literal("extra"));

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
    model: v.string(),
    type: typeValidator,
    input_tokens: v.number(),
    output_tokens: v.number(),
    cache_read_tokens: v.optional(v.number()),
    cache_write_tokens: v.optional(v.number()),
    total_tokens: v.number(),
    cost_dollars: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    await ctx.db.insert("usage_logs", {
      user_id: args.user_id,
      model: args.model,
      type: args.type,
      input_tokens: args.input_tokens,
      output_tokens: args.output_tokens,
      cache_read_tokens: args.cache_read_tokens,
      cache_write_tokens: args.cache_write_tokens,
      total_tokens: args.total_tokens,
      cost_dollars: args.cost_dollars,
    });

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
