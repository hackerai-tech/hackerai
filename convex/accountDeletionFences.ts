import { internalQuery, mutation } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";

export const startByService = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    nowMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const existing = await ctx.db
      .query("account_deletion_fences")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .unique();
    if (existing) return null;

    await ctx.db.insert("account_deletion_fences", {
      user_id: args.userId,
      deletion_started_at: args.nowMs ?? Date.now(),
    });
    return null;
  },
});

export const isSet = internalQuery({
  args: { userId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const fence = await ctx.db
      .query("account_deletion_fences")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .unique();
    return fence !== null;
  },
});
