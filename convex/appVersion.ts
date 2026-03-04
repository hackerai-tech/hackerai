import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";

export const getAppVersion = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => {
    const row = await ctx.db.query("app_version").order("desc").first();
    return row?.build_id ?? null;
  },
});

export const setAppVersion = mutation({
  args: {
    serviceKey: v.string(),
    buildId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const existing = await ctx.db.query("app_version").first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        build_id: args.buildId,
        deployed_at: Date.now(),
      });
    } else {
      await ctx.db.insert("app_version", {
        build_id: args.buildId,
        deployed_at: Date.now(),
      });
    }
    return null;
  },
});
