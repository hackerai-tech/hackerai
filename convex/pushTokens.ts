import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const registerToken = mutation({
  args: {
    token: v.string(),
    platform: v.union(v.literal("ios"), v.literal("android")),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const now = Date.now();
    const existing = await ctx.db
      .query("push_tokens")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        user_id: identity.subject,
        platform: args.platform,
        last_seen_at: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("push_tokens", {
      user_id: identity.subject,
      token: args.token,
      platform: args.platform,
      created_at: now,
      last_seen_at: now,
    });
  },
});

export const unregisterToken = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const existing = await ctx.db
      .query("push_tokens")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();

    if (existing && existing.user_id === identity.subject) {
      await ctx.db.delete(existing._id);
    }
    return null;
  },
});

export const listTokensForCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    return await ctx.db
      .query("push_tokens")
      .withIndex("by_user_id", (q) => q.eq("user_id", identity.subject))
      .collect();
  },
});
