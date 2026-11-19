import type { MutationCtx } from "./serviceFunctions";
import { goalTimingForState } from "../../lib/goals/timing";

/** Reconcile both input owners atomically; releasing one must not end the other. */
export async function syncGoalInputTiming(
  ctx: MutationCtx,
  identity: { chatId: string; userId: string; runId: string },
) {
  const goal = await ctx.db
    .query("agent_goals")
    .withIndex("by_chatId", (q) => q.eq("chatId", identity.chatId))
    .first();
  if (
    goal?.userId !== identity.userId ||
    goal.activeRunId !== identity.runId ||
    goal.state !== "running" ||
    goal.deletedAt !== undefined
  )
    return;

  const chat = await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q) => q.eq("id", identity.chatId))
    .first();
  if (
    chat?.user_id !== identity.userId ||
    chat.active_trigger_run_id !== identity.runId ||
    chat.deletion_started_at !== undefined
  )
    return;
  const browser = await ctx.db
    .query("browser_handoffs")
    .withIndex("by_chat_and_agent", (q) =>
      q.eq("chat_id", identity.chatId).eq("agent_id", "parent"),
    )
    .order("desc")
    .first();
  const waiting =
    chat.active_agent_approval_pending === true ||
    chat.active_agent_user_wait?.runId === identity.runId ||
    (browser?.user_id === identity.userId &&
      browser.run_id === identity.runId &&
      browser.state !== "agent" &&
      browser.state !== "closed");

  // Preserve the running lease and count each active interval only once.
  if (
    waiting
      ? goal.elapsedMs === undefined || goal.activeSince !== undefined
      : goal.activeSince === undefined
  ) {
    await ctx.db.patch(
      goal._id,
      goalTimingForState(goal, waiting ? "needs_input" : "running", Date.now()),
    );
  }
}
