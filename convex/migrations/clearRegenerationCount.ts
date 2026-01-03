import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

/**
 * Migration to clear regeneration_count from all messages.
 * Run repeatedly until isDone is true:
 *
 * while true; do
 *   result=$(npx convex run migrations/clearRegenerationCount:clear --prod)
 *   echo "$result"
 *   if echo "$result" | grep -q '"isDone":true'; then break; fi
 * done
 *
 * After migration completes, remove:
 * 1. The regeneration_count field from schema
 * 2. The by_regeneration_count index from schema
 */
export const clear = internalMutation({
  args: {},
  returns: v.object({
    processed: v.number(),
    isDone: v.boolean(),
  }),
  handler: async (ctx) => {
    // Take 500 at a time - after clearing, they're removed from index
    // so next call gets the next batch automatically
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_regeneration_count", (q) => q.gte("regeneration_count", 0))
      .take(500);

    for (const message of messages) {
      await ctx.db.patch(message._id, {
        regeneration_count: undefined,
      });
    }

    return {
      processed: messages.length,
      isDone: messages.length === 0,
    };
  },
});

