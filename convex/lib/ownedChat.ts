import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export async function requireUserId(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError({
      code: "UNAUTHORIZED",
      message: "Unauthorized: User not authenticated",
    });
  }
  return identity.subject;
}

/** The user's chat, unless it is someone else's or being deleted. */
export async function getOwnedChat(
  ctx: QueryCtx | MutationCtx,
  chatId: string,
  userId: string,
) {
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q) => q.eq("id", chatId))
    .first();
  if (!chat || chat.user_id !== userId || chat.deletion_started_at) return null;
  return chat;
}
