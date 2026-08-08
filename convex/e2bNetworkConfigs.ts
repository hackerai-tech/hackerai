import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const outboundModeValidator = v.union(
  v.literal("unrestricted"),
  v.literal("allow_only"),
  v.literal("block_list"),
);
const storedConfigValidator = v.object({
  _id: v.id("e2b_network_configs"),
  _creationTime: v.number(),
  user_id: v.string(),
  outbound_mode: outboundModeValidator,
  destinations: v.array(v.string()),
  updated_at: v.number(),
});

export const getForUser = internalQuery({
  args: { userId: v.string() },
  returns: v.union(v.null(), storedConfigValidator),
  handler: async (ctx, args) =>
    ctx.db
      .query("e2b_network_configs")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .unique(),
});

export const upsertForUser = internalMutation({
  args: {
    userId: v.string(),
    outboundMode: outboundModeValidator,
    destinations: v.array(v.string()),
    updatedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("e2b_network_configs")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .unique();
    const value = {
      outbound_mode: args.outboundMode,
      destinations: args.destinations,
      updated_at: args.updatedAt,
    };

    if (existing) {
      await ctx.db.patch(existing._id, value);
    } else {
      await ctx.db.insert("e2b_network_configs", {
        user_id: args.userId,
        ...value,
      });
    }
    return null;
  },
});
