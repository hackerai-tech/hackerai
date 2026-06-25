import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";

const suspensionCategoryValidator = v.union(
  v.literal("early_fraud_warning"),
  v.literal("dispute_fraudulent"),
  v.literal("dispute_billing_hold"),
);

export const getActiveByUser = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    return await ctx.db
      .query("user_suspensions")
      .withIndex("by_user_status_source_created", (q) =>
        q.eq("user_id", args.userId).eq("status", "active"),
      )
      .order("desc")
      .first();
  },
});

export const getActiveFraudDisputeByUser = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    return await ctx.db
      .query("user_suspensions")
      .withIndex("by_user_status_category_source_created", (q) =>
        q
          .eq("user_id", args.userId)
          .eq("status", "active")
          .eq("category", "dispute_fraudulent"),
      )
      .order("desc")
      .first();
  },
});

export const upsertActive = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    category: suspensionCategoryValidator,
    sourceId: v.string(),
    sourceReason: v.optional(v.string()),
    stripeCustomerId: v.string(),
    stripeChargeId: v.optional(v.string()),
    workosOrganizationId: v.optional(v.string()),
    sourceCreatedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const now = Date.now();
    const existing = await ctx.db
      .query("user_suspensions")
      .withIndex("by_user_and_source", (q) =>
        q.eq("user_id", args.userId).eq("source_id", args.sourceId),
      )
      .first();

    const fields = {
      status: "active" as const,
      category: args.category,
      source: "stripe" as const,
      source_id: args.sourceId,
      source_reason: args.sourceReason,
      stripe_customer_id: args.stripeCustomerId,
      stripe_charge_id: args.stripeChargeId,
      workos_organization_id: args.workosOrganizationId,
      updated_at: now,
      source_created_at: args.sourceCreatedAt ?? now,
      resolved_at: undefined,
      resolved_reason: undefined,
    };

    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }

    return await ctx.db.insert("user_suspensions", {
      ...fields,
      user_id: args.userId,
      created_at: now,
    });
  },
});

export const resolveBySource = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    sourceId: v.string(),
    resolvedReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const suspension = await ctx.db
      .query("user_suspensions")
      .withIndex("by_user_and_source", (q) =>
        q.eq("user_id", args.userId).eq("source_id", args.sourceId),
      )
      .first();

    if (!suspension) return { resolved: false };

    const now = Date.now();
    await ctx.db.patch(suspension._id, {
      status: "resolved",
      resolved_at: now,
      resolved_reason: args.resolvedReason,
      updated_at: now,
    });

    return { resolved: true };
  },
});
