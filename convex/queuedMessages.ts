import { ConvexError, v } from "convex/values";
import { mutation, query } from "./lib/serviceFunctions";
import { getOwnedChat, requireUserId } from "./lib/ownedChat";
import {
  findQueuedMessage,
  insertQueuedMessage,
  queuedMessagesForChat,
} from "./lib/queuedMessages";
import { QUEUED_MESSAGE_MAX_TEXT_LENGTH } from "../lib/chat/queued-message";

const queuedMessageValidator = v.object({
  id: v.string(),
  text: v.string(),
  files: v.optional(v.array(v.any())),
  sentAt: v.number(),
  fromSteer: v.boolean(),
});

/** The chat's queue, oldest first. */
export const list = query({
  args: { chatId: v.string() },
  returns: v.array(queuedMessageValidator),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    if (!(await getOwnedChat(ctx, args.chatId, identity.subject))) return [];
    const rows = await queuedMessagesForChat(ctx, args.chatId);
    return rows
      .filter((row) => row.user_id === identity.subject)
      .map((row) => ({
        id: row.id,
        text: row.text,
        ...(row.files?.length ? { files: row.files } : {}),
        sentAt: row.sent_at,
        fromSteer: row.from_steer === true,
      }));
  },
});

export const enqueue = mutation({
  args: {
    chatId: v.string(),
    id: v.string(),
    text: v.string(),
    files: v.optional(v.array(v.any())),
    sentAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    if (!(await getOwnedChat(ctx, args.chatId, userId))) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "Unauthorized: Chat not found",
      });
    }
    await insertQueuedMessage(ctx, { ...args, userId });
    return null;
  },
});

async function ownedRow(
  ctx: Parameters<typeof requireUserId>[0],
  args: { chatId: string; id: string },
) {
  const userId = await requireUserId(ctx);
  const row = await findQueuedMessage(ctx, args.id);
  return row && row.user_id === userId && row.chat_id === args.chatId
    ? row
    : null;
}

/** Edits a queued message's text. Missing rows were already sent or removed. */
export const update = mutation({
  args: { chatId: v.string(), id: v.string(), text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.text.length > QUEUED_MESSAGE_MAX_TEXT_LENGTH) {
      throw new ConvexError({
        code: "INVALID_QUEUED_MESSAGE",
        message: "This message is too long to queue.",
      });
    }
    const row = await ownedRow(ctx, args);
    if (row) await ctx.db.patch(row._id, { text: args.text });
    return null;
  },
});

export const remove = mutation({
  args: { chatId: v.string(), id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ownedRow(ctx, args);
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});
