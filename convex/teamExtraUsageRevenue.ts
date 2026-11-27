import { v } from "convex/values";
import { internalMutation, internalQuery } from "./lib/serviceFunctions";
import {
  recomputeTeamExtraUsageRevenueDay,
  TEAM_EXTRA_USAGE_REVENUE_FIRST_COMPLETE_DAY,
  utcDay,
  utcDayStartMs,
} from "./unitEconomicsLib";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BACKFILL_DAYS = 31;
const MAX_COVERAGE_DAYS = 366;

function daysInRange(startDay: string, endDay: string, maxDays: number) {
  const start = utcDayStartMs(startDay);
  const end = utcDayStartMs(endDay);
  if (start > end) throw new Error("startDay must not be after endDay");
  const count = (end - start) / DAY_MS + 1;
  if (count > maxDays) {
    throw new Error(`Range must cover at most ${maxDays} days`);
  }
  return Array.from({ length: count }, (_, i) => utcDay(start + i * DAY_MS));
}

const dayResultValidator = v.union(
  v.object({
    day: v.string(),
    status: v.union(v.literal("written"), v.literal("unchanged")),
    netRevenueDollars: v.number(),
    revenueEventCount: v.number(),
  }),
  v.object({
    day: v.string(),
    status: v.literal("unknown"),
    reason: v.union(
      v.literal("too_many_receipts"),
      v.literal("non_usd_receipt"),
      v.literal("invalid_amount"),
    ),
  }),
);

/**
 * Recompute complete UTC days from canonical receipts, writing explicit zero
 * rows for swept days without receipts. Safe to repeat or overlap: every day is
 * replaced with its exact total, and live top-ups recompute the same way.
 */
export const backfillDaily = internalMutation({
  args: { startDay: v.string(), endDay: v.string() },
  returns: v.array(dayResultValidator),
  handler: async (ctx, args) => {
    const days = daysInRange(args.startDay, args.endDay, MAX_BACKFILL_DAYS);
    if (args.startDay < TEAM_EXTRA_USAGE_REVENUE_FIRST_COMPLETE_DAY) {
      throw new Error(
        `Receipts are incomplete before ${TEAM_EXTRA_USAGE_REVENUE_FIRST_COMPLETE_DAY}`,
      );
    }
    if (args.endDay >= utcDay(Date.now())) {
      throw new Error("endDay must be a completed UTC day");
    }

    const results = [];
    for (const day of days) {
      results.push(await recomputeTeamExtraUsageRevenueDay(ctx, day));
    }
    return results;
  },
});

/** Verification view: stored days plus days with no coverage row. */
export const getCoverage = internalQuery({
  args: { startDay: v.string(), endDay: v.string() },
  returns: v.object({
    rows: v.array(
      v.object({
        day: v.string(),
        netRevenueDollars: v.number(),
        revenueEventCount: v.number(),
      }),
    ),
    missingDays: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const days = daysInRange(args.startDay, args.endDay, MAX_COVERAGE_DAYS);
    const stored = await ctx.db
      .query("team_extra_usage_revenue_daily")
      .withIndex("by_day", (q) =>
        q.gte("day", args.startDay).lte("day", args.endDay),
      )
      .take(MAX_COVERAGE_DAYS);
    const covered = new Set(stored.map((row) => row.day));
    return {
      rows: stored.map((row) => ({
        day: row.day,
        netRevenueDollars: row.net_revenue_dollars,
        revenueEventCount: row.revenue_event_count,
      })),
      missingDays: days.filter((day) => !covered.has(day)),
    };
  },
});
