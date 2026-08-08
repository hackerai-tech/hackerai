import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const inboundModeValidator = v.union(
  v.literal("public"),
  v.literal("token_required"),
);
const outboundModeValidator = v.union(
  v.literal("unrestricted"),
  v.literal("allow_only"),
  v.literal("block_list"),
);

export const getForUser = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) =>
    ctx.db
      .query("e2b_network_configs")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .unique(),
});

export const upsertForUser = internalMutation({
  args: {
    userId: v.string(),
    inboundMode: inboundModeValidator,
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
      inbound_mode: args.inboundMode,
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
