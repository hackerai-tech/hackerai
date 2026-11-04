import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./lib/serviceFunctions";
import { validateServiceKey } from "./lib/utils";
import { isUserDeletionFenced } from "./lib/userDeletionFence";
import { assertUserCanAccessChatHistory } from "./lib/suspensionGuards";
import {
  nextActionsBatchValidator,
  nextActionsStateValidator,
} from "./lib/nextActionsState";

const ownerArgs = {
  serviceKey: v.string(),
  userId: v.string(),
  chatId: v.string(),
  messageId: v.string(),
};

async function completedChat(
  ctx: QueryCtx,
  args: {
    serviceKey: string;
    userId: string;
    chatId: string;
    messageId: string;
  },
) {
  validateServiceKey(args.serviceKey);
  await assertUserCanAccessChatHistory(ctx, args.userId);
  if (await isUserDeletionFenced(ctx.db, args.userId)) return null;
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
    .first();
  if (
    !chat ||
    chat.user_id !== args.userId ||
    chat.deletion_started_at !== undefined ||
    chat.canceled_at !== undefined ||
    chat.active_stream_id ||
    chat.active_trigger_run_id ||
    chat.active_agent_approval_pending ||
    chat.finish_reason !== "stop" ||
    !chat.last_run_finished_at
  )
    return null;
  const latest = await ctx.db
    .query("messages")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
    .order("desc")
    .first();
  if (
    !latest ||
    latest.id !== args.messageId ||
    latest.role !== "assistant" ||
    latest.user_id !== args.userId
  )
    return null;
  return chat;
}

export const getForBackend = query({
  args: ownerArgs,
  returns: v.union(nextActionsStateValidator, v.null()),
  handler: async (ctx, args) => {
    const chat = await completedChat(ctx, args);
    const saved = chat?.next_actions;
    if (
      !saved ||
      saved.messageId !== args.messageId ||
      saved.finishedAt !== chat?.last_run_finished_at
    )
      return null;
    if (
      saved.batch &&
      saved.batch.mode !== (chat.default_model_slug === "ask" ? "ask" : "agent")
    )
      return null;
    return saved;
  },
});

export const saveForBackend = mutation({
  args: {
    ...ownerArgs,
    finishedAt: v.number(),
    batch: nextActionsBatchValidator,
  },
  returns: v.union(nextActionsBatchValidator, v.null()),
  handler: async (ctx, args) => {
    const chat = await completedChat(ctx, args);
    if (
      !chat ||
      chat.last_run_finished_at !== args.finishedAt ||
      args.batch.messageId !== args.messageId ||
      args.batch.mode !== (chat.default_model_slug === "ask" ? "ask" : "agent")
    )
      return null;
    if (
      !args.batch.suggestions.length ||
      args.batch.suggestions.length > 3 ||
      args.batch.suggestions.some(
        (text) => !text.trim() || text.length > 240,
      ) ||
      args.batch.batchId.length > 100
    )
      return null;
    const saved = chat.next_actions;
    if (
      saved?.messageId === args.messageId &&
      saved.finishedAt === args.finishedAt
    )
      return saved.consumed ? null : (saved.batch ?? null);
    await ctx.db.patch(chat._id, {
      next_actions: {
        messageId: args.messageId,
        finishedAt: args.finishedAt,
        consumed: false,
        batch: args.batch,
      },
    });
    return args.batch;
  },
});

export const consumeForBackend = mutation({
  args: ownerArgs,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const chat = await completedChat(ctx, args);
    if (!chat) return false;
    // Also fence an in-flight generation: a late save cannot revive dismissal.
    await ctx.db.patch(chat._id, {
      next_actions: {
        messageId: args.messageId,
        finishedAt: chat.last_run_finished_at!,
        consumed: true,
      },
    });
    return true;
  },
});
