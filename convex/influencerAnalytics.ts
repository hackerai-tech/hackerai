import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { validateServiceKey } from "./lib/utils";
import {
  analyticsFields,
  queueInfluencerEvent,
  validVisitor,
} from "./lib/influencerAnalytics";

const auth = { serviceKey: v.string() };
export const recordVisit = mutation({
  args: {
    ...auth,
    code: v.string(),
    visitorId: v.string(),
    visitId: v.string(),
    timestamp: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (!validVisitor(args.visitorId) || !validVisitor(args.visitId))
      return null;
    const partner = await ctx.db
      .query("influencer_partners")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique();
    if (!partner?.active) return null;
    await queueInfluencerEvent(ctx, {
      key: `visit:${args.visitId}`,
      event: "influencer_link_visited",
      visitor_id: args.visitorId,
      code: partner.code,
      timestamp: args.timestamp ?? Date.now(),
    });
    return null;
  },
});
export const recordCheckout = mutation({
  args: {
    ...auth,
    identity: v.string(),
    attemptId: v.string(),
    plan: v.string(),
    interval: v.string(),
    timestamp: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (
      !args.attemptId ||
      args.attemptId.length > 200 ||
      args.plan.length > 100 ||
      args.interval.length > 20
    )
      return null;
    const attribution = await ctx.db
      .query("influencer_attributions")
      .withIndex("by_identity", (q) => q.eq("identity", args.identity))
      .unique();
    if (!attribution?.analytics_visitor_id || !attribution.customer_id)
      return null;
    if (attribution.analytics_checkout_at === undefined)
      await ctx.db.patch(attribution._id, {
        analytics_checkout_at: args.timestamp ?? Date.now(),
      });
    const partner = await ctx.db.get(attribution.partner_id);
    if (partner)
      await queueInfluencerEvent(ctx, {
        key: `checkout:${args.attemptId}`,
        event: "influencer_checkout_started",
        visitor_id: attribution.analytics_visitor_id,
        code: partner.code,
        timestamp: args.timestamp ?? Date.now(),
        properties: { plan: args.plan, billing_interval: args.interval },
      });
    return null;
  },
});
export const pending = query({
  args: auth,
  returns: v.array(
    v.object({
      ...analyticsFields,
      _id: v.id("influencer_analytics"),
      _creationTime: v.number(),
      suppressed: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const rows = await ctx.db
      .query("influencer_analytics")
      .withIndex("by_delivered", (q) => q.eq("delivered", false))
      .take(100);
    return await Promise.all(
      rows.map(async (row) => ({
        ...row,
        suppressed: !!(await ctx.db
          .query("influencer_analytics_optouts")
          .withIndex("by_visitor", (q) => q.eq("visitor_id", row.visitor_id))
          .unique()),
      })),
    );
  },
});
export const acknowledge = mutation({
  args: { ...auth, ids: v.array(v.id("influencer_analytics")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (args.ids.length > 100) throw new Error("Batch too large");
    for (const id of args.ids)
      if (await ctx.db.get(id)) await ctx.db.patch(id, { delivered: true });
    // Keep recent deduplication keys; checkout sessions and attribution windows expire before this cutoff.
    const old = await ctx.db
      .query("influencer_analytics")
      .withIndex("by_delivered", (q) =>
        q
          .eq("delivered", true)
          .lt("_creationTime", Date.now() - 90 * 86400_000),
      )
      .take(100);
    for (const row of old) await ctx.db.delete(row._id);
    return null;
  },
});

/** Cumulative USD sponsorship spend, set explicitly by an operator; corrections emit signed deltas. */
export const setSponsorshipCost = mutation({
  args: { ...auth, code: v.string(), amountCents: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (!Number.isSafeInteger(args.amountCents) || args.amountCents < 0)
      throw new Error("Invalid USD cents");
    const partner = await ctx.db
      .query("influencer_partners")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique();
    if (!partner) throw new Error("Partner not found");
    const previous = partner.sponsorship_cost_cents ?? 0;
    if (previous === args.amountCents) return null;
    const revision = (partner.sponsorship_cost_revision ?? 0) + 1;
    await ctx.db.patch(partner._id, {
      sponsorship_cost_cents: args.amountCents,
      sponsorship_cost_revision: revision,
    });
    await queueInfluencerEvent(ctx, {
      key: `sponsorship:${partner._id}:${revision}`,
      event: "influencer_sponsorship_cost_adjusted",
      visitor_id: "00000000-0000-4000-8000-000000000000",
      code: partner.code,
      timestamp: Date.now(),
      properties: {
        currency: "usd",
        sponsorship_cost_delta_cents: args.amountCents - previous,
      },
    });
    return null;
  },
});

/** IDs come only from verified server cookies or the authenticated WorkOS session. */
export const optOut = mutation({
  args: {
    ...auth,
    visitorId: v.optional(v.string()),
    userId: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const visitors = new Set<string>();
    if (validVisitor(args.visitorId)) visitors.add(args.visitorId);
    let nextCursor: string | null = null;
    if (args.userId) {
      const page = await ctx.db
        .query("account_identities")
        .withIndex("by_latest_user_id", (q) =>
          q.eq("latest_user_id", args.userId!),
        )
        .paginate({ cursor: args.cursor ?? null, numItems: 100 });
      nextCursor = page.isDone ? null : page.continueCursor;
      for (const identity of page.page) {
        const attribution = await ctx.db
          .query("influencer_attributions")
          .withIndex("by_identity", (q) =>
            q.eq("identity", identity.identity_hash),
          )
          .unique();
        if (validVisitor(attribution?.analytics_visitor_id))
          visitors.add(attribution.analytics_visitor_id);
      }
    }
    for (const visitorId of visitors) {
      const existing = await ctx.db
        .query("influencer_analytics_optouts")
        .withIndex("by_visitor", (q) => q.eq("visitor_id", visitorId))
        .unique();
      if (!existing)
        await ctx.db.insert("influencer_analytics_optouts", {
          visitor_id: visitorId,
        });
    }
    return nextCursor;
  },
});
