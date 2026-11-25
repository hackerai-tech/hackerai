import type { MutationCtx } from "../_generated/server";

// A Convex document can approach 1 MiB and mutations have a 16 MiB read cap.
// Leave at least half the budget for the owning chat-deletion mutation.
const LEGACY_SCOPE_EVENT_DELETE_BATCH_SIZE = 8;

/** Retire legacy scope records only when their owning chat is deleted. */
export async function deleteScopeBatch(
  ctx: MutationCtx,
  chatId: string,
): Promise<boolean> {
  const events = await ctx.db
    .query("engagement_scope_events")
    .withIndex("by_chat_source", (q) => q.eq("chat_id", chatId))
    .take(LEGACY_SCOPE_EVENT_DELETE_BATCH_SIZE);
  for (const event of events) await ctx.db.delete(event._id);
  if (events.length === LEGACY_SCOPE_EVENT_DELETE_BATCH_SIZE) return true;

  const row = await ctx.db
    .query("engagement_scopes")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", chatId))
    .unique();
  if (row) await ctx.db.delete(row._id);
  return false;
}
