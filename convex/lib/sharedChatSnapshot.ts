import type { GenericDatabaseReader } from "convex/server";
import { v } from "convex/values";

import type { DataModel, Doc } from "../_generated/dataModel";
import { stripOpenRouterReasoningMetadataFromParts } from "../../lib/chat/provider-metadata-sanitizer";
import { isUserBlockedFromChatHistory } from "./suspensionGuards";

type SharedChatReaderCtx = {
  db: GenericDatabaseReader<DataModel>;
};

export type VisibleSharedChat = Doc<"chats"> & {
  share_id: string;
  share_date: number;
};

export const sharedChatValidator = v.object({
  _id: v.id("chats"),
  id: v.string(),
  title: v.string(),
  share_id: v.string(),
  share_date: v.number(),
  update_time: v.number(),
});

export const sharedMessageValidator = v.object({
  id: v.string(),
  role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
  parts: v.array(v.any()),
  content: v.optional(v.string()),
  update_time: v.number(),
});

const resolveVisibleSharedChat = async (
  ctx: SharedChatReaderCtx,
  chat: Doc<"chats"> | null,
): Promise<VisibleSharedChat | null> => {
  if (!chat?.share_id || !chat.share_date) {
    return null;
  }

  if (await isUserBlockedFromChatHistory(ctx, chat.user_id)) {
    return null;
  }

  return chat as VisibleSharedChat;
};

export const getVisibleSharedChatByShareId = async (
  ctx: SharedChatReaderCtx,
  shareId: string,
): Promise<VisibleSharedChat | null> => {
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_share_id", (q) => q.eq("share_id", shareId))
    .first();

  return resolveVisibleSharedChat(ctx, chat);
};

export const serializeSharedChat = (chat: VisibleSharedChat) => ({
  _id: chat._id,
  id: chat.id,
  title: chat.title,
  share_id: chat.share_id,
  share_date: chat.share_date,
  update_time: chat.update_time,
});

export const listVisibleSharedMessages = async (
  ctx: SharedChatReaderCtx,
  chat: VisibleSharedChat,
) => {
  // Preserve the existing full shared-task response contract. The query is
  // indexed by chat ID; pagination would be a separate user-visible change.
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", chat.id))
    .order("asc")
    .collect();

  return messages
    .filter(
      (message) =>
        message.update_time <= chat.share_date && message.is_hidden !== true,
    )
    .sort(
      (a, b) =>
        a.update_time - b.update_time || a._creationTime - b._creationTime,
    )
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      update_time: message.update_time,
      parts: stripOpenRouterReasoningMetadataFromParts(message.parts).map(
        (part: any) => {
          if (part.type === "file") {
            return {
              type: part.mediaType?.startsWith("image/") ? "image" : "file",
              placeholder: true,
            };
          }

          return part;
        },
      ),
    }));
};
