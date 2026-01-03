import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

/**
 * Migration to clear regeneration_count from all messages.
 * This prepares for removing the by_regeneration_count index.
 *
 * Run this migration:
 * npx convex run migrations/clearRegenerationCount:clear --prod
 *
 * After migration completes, remove:
 * 1. The regeneration_count field from schema
 * 2. The by_regeneration_count index from schema
 */

/**
 * Clear regeneration_count from all messages.
 * Uses index with gte() to find documents where regeneration_count >= 0.
 * After we set it to undefined, they'll be removed from the index.
 */
export const clear = internalMutation({
  args: {},
  returns: v.object({
    processed: v.number(),
  }),
  handler: async (ctx) => {
    // Query all messages where regeneration_count is defined (>= 0)
    // After we set it to undefined, they'll be removed from the index
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_regeneration_count", (q) => q.gte("regeneration_count", 0))
      .collect();

    for (const message of messages) {
      await ctx.db.patch(message._id, {
        regeneration_count: undefined,
      });
    }

    return {
      processed: messages.length,
    };
  },
});

