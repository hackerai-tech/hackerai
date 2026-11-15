import { v } from "convex/values";
import { internalMutation } from "./lib/serviceFunctions";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./lib/serviceFunctions";
import type { Id } from "./_generated/dataModel";

// Legacy executable HTTP retest rows from Preview have no read, write or run
// path. Only bounded deletion remains, so chat, finding and user deletion
// still remove them.

const DELETE_BATCH_SIZE = 50;

/**
 * Delete one batch of legacy retest rows for a chat. Returns true while rows
 * remain, so chat deletion can reschedule before removing the chat itself.
 */
export async function deleteFindingRetestsForChatBatch(
  ctx: MutationCtx,
  userId: string,
  chatId: string,
): Promise<boolean> {
  for (const table of [
    "finding_retest_runs",
    "finding_retest_recipes",
  ] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_user_and_chat", (q) =>
        q.eq("user_id", userId).eq("chat_id", chatId),
      )
      .take(DELETE_BATCH_SIZE + 1);
    for (const row of rows.slice(0, DELETE_BATCH_SIZE))
      await ctx.db.delete(row._id as Id<typeof table>);
    if (rows.length > DELETE_BATCH_SIZE) return true;
  }
  return false;
}

/** Continue cleanup of an individual deleted finding in bounded batches. */
export const deleteForFinding = internalMutation({
  args: { findingId: v.string(), userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const recipes = await ctx.db
      .query("finding_retest_recipes")
      .withIndex("by_finding_and_version", (q) =>
        q.eq("finding_id", args.findingId),
      )
      .take(DELETE_BATCH_SIZE + 1);
    const runs = await ctx.db
      .query("finding_retest_runs")
      .withIndex("by_finding_and_started", (q) =>
        q.eq("finding_id", args.findingId),
      )
      .take(DELETE_BATCH_SIZE + 1);
    for (const row of [
      ...recipes.slice(0, DELETE_BATCH_SIZE),
      ...runs.slice(0, DELETE_BATCH_SIZE),
    ]) {
      if (row.user_id === args.userId) await ctx.db.delete(row._id);
    }
    if (recipes.length > DELETE_BATCH_SIZE || runs.length > DELETE_BATCH_SIZE)
      await ctx.scheduler.runAfter(
        0,
        internal.findingRetests.deleteForFinding,
        args,
      );
    return null;
  },
});
