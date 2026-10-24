import type { MutationCtx } from "../_generated/server";

/** Retire legacy scope records only when their owning chat is deleted. */
export async function deleteScopeBatch(
  ctx: MutationCtx,
  chatId: string,
): Promise<boolean> {
  const events = await ctx.db
    .query("engagement_scope_events")
    .withIndex("by_chat_source", (q) => q.eq("chat_id", chatId))
    .take(100);
  for (const event of events) await ctx.db.delete(event._id);
  if (events.length === 100) return true;
  const row = await ctx.db
    .query("engagement_scopes")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", chatId))
    .unique();
  if (row) await ctx.db.delete(row._id);
  return false;
}
