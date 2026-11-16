import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";

// Keep this record independent of mutable run/sidebar state. Reading the chat
// itself makes every subscribed history page depend on all chat status writes.
export async function createChatHistoryAccess(
  ctx: MutationCtx,
  chatId: string,
  userId: string,
) {
  await ctx.db.insert("chat_history_access", {
    chat_id: chatId,
    user_id: userId,
  });
}

// Lazily covers chats created before the access record existed. Callers pass a
// chat already admitted for writing in the same transaction. An existing row is
// authoritative and never rewritten, so a conflicting owner still denies reads.
export async function ensureChatHistoryAccess(
  ctx: MutationCtx,
  chat: Pick<Doc<"chats">, "id" | "user_id">,
) {
  const access = await ctx.db
    .query("chat_history_access")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", chat.id))
    .unique();
  if (!access) await createChatHistoryAccess(ctx, chat.id, chat.user_id);
}

export async function deleteChatHistoryAccess(
  ctx: MutationCtx,
  chatId: string,
) {
  const access = await ctx.db
    .query("chat_history_access")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", chatId))
    .unique();
  if (access) await ctx.db.delete(access._id);
}

export async function assertChatHistoryOwner(
  ctx: QueryCtx,
  chatId: string,
  userId: string,
) {
  const access = await ctx.db
    .query("chat_history_access")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", chatId))
    .unique();
  // Existing chats remain readable before backfill. Creation/deletion maintain
  // the access row in the same transaction as the chat, including forks.
  const owner =
    access ??
    (await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", chatId))
      .first());
  if (!owner)
    throw new ConvexError({
      code: "CHAT_NOT_FOUND",
      message: "This chat doesn't exist",
    });
  if (owner.user_id !== userId)
    throw new ConvexError({
      code: "CHAT_UNAUTHORIZED",
      message: "You don't have permission to access this chat",
    });
}
