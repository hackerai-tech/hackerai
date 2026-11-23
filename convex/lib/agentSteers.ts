import type { MutationCtx } from "../_generated/server";
import { AGENT_STEER_MAX_PENDING } from "../../lib/chat/agent-steer";

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
