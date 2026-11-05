import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "./serviceFunctions";

/** Only public attention bits belong in a sidebar row. */
export async function getSidebarChatAttention(
  ctx: QueryCtx,
  chats: Doc<"chats">[],
) {
  return Promise.all(
    chats.map(async (chat) => {
      const goal = await ctx.db
        .query("agent_goals")
        .withIndex("by_chatId", (q) => q.eq("chatId", chat.id))
        .unique();
      const browser = chat.active_trigger_run_id
        ? await ctx.db
            .query("browser_handoffs")
            .withIndex("by_chat_and_agent", (q) =>
              q.eq("chat_id", chat.id).eq("agent_id", "parent"),
            )
            .order("desc")
            .first()
        : null;

      return {
        goal_needs_input:
          !chat.deletion_started_at &&
          goal?.userId === chat.user_id &&
          !goal.deletedAt &&
          goal.state === "needs_input",
        browser_needs_input:
          !chat.deletion_started_at &&
          browser?.user_id === chat.user_id &&
          browser.run_id === chat.active_trigger_run_id &&
          browser.expires_at > Date.now() &&
          (browser.state === "waiting" || browser.state === "recovery"),
      };
    }),
  );
}
