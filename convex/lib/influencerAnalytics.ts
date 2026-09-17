import type { MutationCtx } from "../_generated/server";
import { v } from "convex/values";

export const analyticsFields = {
  key: v.string(),
  event: v.string(),
  visitor_id: v.string(),
  code: v.string(),
  timestamp: v.number(),
  properties: v.record(
    v.string(),
    v.union(v.string(), v.number(), v.boolean()),
  ),
  delivered: v.boolean(),
};
export const validVisitor = (value: string | undefined): value is string =>
  !!value &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    value,
  );

/** Called within the business mutation, so committed transitions survive telemetry outages. */
export async function queueInfluencerEvent(
  ctx: MutationCtx,
  data: {
    key: string;
    event: string;
    visitor_id: string;
    code: string;
    timestamp: number;
    properties?: Record<string, string | number | boolean>;
  },
) {
  if (!validVisitor(data.visitor_id)) return;
  if (
    await ctx.db
      .query("influencer_analytics_optouts")
      .withIndex("by_visitor", (q) => q.eq("visitor_id", data.visitor_id))
      .unique()
  )
    return;
  const existing = await ctx.db
    .query("influencer_analytics")
    .withIndex("by_key", (q) => q.eq("key", data.key))
    .unique();
  if (!existing)
    await ctx.db.insert("influencer_analytics", {
      ...data,
      properties: data.properties ?? {},
      delivered: false,
    });
}
