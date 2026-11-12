import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { replaceCostRows, rowValidator } from "./platformCosts";

/**
 * Imports billing observations collected through authenticated vendor connectors.
 * This function is internal: only a deployment administrator can invoke it.
 * Public clients and the normal service credential cannot submit invoice data.
 */
export const importBillingWindow = internalMutation({
  args: {
    vendor: v.union(
      v.literal("workos"),
      v.literal("upstash"),
      v.literal("convex"),
    ),
    startDay: v.string(),
    endDay: v.string(),
    observedAt: v.number(),
    rows: v.array(rowValidator),
  },
  returns: v.object({
    inserted: v.number(),
    updated: v.number(),
    deleted: v.number(),
    unchanged: v.number(),
  }),
  handler: async (ctx, args) => {
    if (!args.rows.length)
      throw new Error("An empty billing import cannot erase known charges");
    return replaceCostRows(ctx, { ...args, scope: "charges" });
  },
});
