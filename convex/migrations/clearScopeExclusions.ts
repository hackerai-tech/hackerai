import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

/**
 * Migration to clear scope_exclusions field from user_customization documents.
 * Uses index to efficiently find only documents with scope_exclusions set.
 *
 * Run via: npx convex run migrations/clearScopeExclusions:clearBatch
 * Keep running until it returns { done: true }
 */
export const clearBatch = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? 100;

    // Use index and filter for non-undefined scope_exclusions
    const results = await ctx.db
      .query("user_customization")
      .withIndex("by_scope_exclusions")
      .filter((q) => q.neq(q.field("scope_exclusions"), undefined))
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let updated = 0;
    for (const doc of results.page) {
      await ctx.db.patch(doc._id, { scope_exclusions: undefined });
      updated++;
    }

    return {
      updated,
      processed: results.page.length,
      done: results.isDone,
      continueCursor: results.isDone ? null : results.continueCursor,
    };
  },
});
