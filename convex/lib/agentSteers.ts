import type { MutationCtx } from "../_generated/server";
import {
  AGENT_STEER_MAX_PENDING,
  isAgentSteerPart,
} from "../../lib/chat/agent-steer";

/** Chat deletion removes unread steers with the rest of the chat's content. */
export async function deleteAgentSteersForChat(
  ctx: MutationCtx,
  chatId: string,
) {
  const rows = await ctx.db
    .query("agent_steers")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", chatId))
    .take(AGENT_STEER_MAX_PENDING * 2);
  for (const row of rows) await ctx.db.delete(row._id);
}

/**
 * A saved response that shows a steer retires its row in the same
 * transaction. A row that remains was never saved, so it can be requeued.
 */
export async function retireSavedSteers(
  ctx: MutationCtx,
  args: { chatId: string; userId: string; parts: unknown[] },
) {
  for (const part of args.parts) {
    if (!isAgentSteerPart(part)) continue;
    const row = await ctx.db
      .query("agent_steers")
      .withIndex("by_steer_id", (q) => q.eq("id", part.data.id))
      .first();
    if (row && row.chat_id === args.chatId && row.user_id === args.userId)
      await ctx.db.delete(row._id);
  }
}
