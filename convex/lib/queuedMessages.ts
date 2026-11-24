import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { QueuedMessageSettings } from "../../lib/chat/queued-message";
import {
  QUEUED_MESSAGE_DISPATCH_CLAIM_TTL_MS,
  QUEUED_MESSAGE_MAX_COUNT,
  QUEUED_MESSAGE_MAX_TEXT_LENGTH,
  isValidQueuedMessageId,
  sanitizeQueuedFiles,
} from "../../lib/chat/queued-message";

export const QUEUED_MESSAGE_DELETE_BATCH = 100;

/** A server send owns the row until its run is attached or the lease ends. */
export const isDispatchClaimed = (row: Doc<"queued_messages">, now: number) =>
  row.dispatch_claimed_at !== undefined &&
  now - row.dispatch_claimed_at < QUEUED_MESSAGE_DISPATCH_CLAIM_TTL_MS;

export const queuedMessagesForChat = (
  ctx: QueryCtx | MutationCtx,
  chatId: string,
) =>
  ctx.db
    .query("queued_messages")
    .withIndex("by_chat_and_sent", (q) => q.eq("chat_id", chatId))
    .take(QUEUED_MESSAGE_MAX_COUNT * 2);

export const findQueuedMessage = (ctx: QueryCtx | MutationCtx, id: string) =>
  ctx.db
    .query("queued_messages")
    .withIndex("by_queued_id", (q) => q.eq("id", id))
    .first();

/**
 * Adds a message to the chat's queue. A steer returned after its run ended
 * was already accepted once, so it is never refused for a full queue.
 */
export async function insertQueuedMessage(
  ctx: MutationCtx,
  args: {
    id: string;
    chatId: string;
    userId: string;
    text: string;
    files?: unknown[];
    sentAt: number;
    fromSteer?: boolean;
    settings?: QueuedMessageSettings;
  },
) {
  const files = sanitizeQueuedFiles(args.files);
  if (
    !isValidQueuedMessageId(args.id) ||
    args.text.length > QUEUED_MESSAGE_MAX_TEXT_LENGTH ||
    (!args.text.trim() && !files.length)
  ) {
    throw new ConvexError({
      code: "INVALID_QUEUED_MESSAGE",
      message: "This message cannot be queued.",
    });
  }
  if (await findQueuedMessage(ctx, args.id)) return;
  if (
    !args.fromSteer &&
    (await queuedMessagesForChat(ctx, args.chatId)).length >=
      QUEUED_MESSAGE_MAX_COUNT
  ) {
    throw new ConvexError({
      code: "QUEUE_FULL",
      message: "Please wait for queued messages to send before adding more.",
    });
  }
  await ctx.db.insert("queued_messages", {
    id: args.id,
    chat_id: args.chatId,
    user_id: args.userId,
    text: args.text,
    ...(files.length ? { files } : {}),
    sent_at: args.sentAt,
    ...(args.fromSteer ? { from_steer: true } : {}),
    ...(args.settings ? { settings: args.settings } : {}),
    created_at: Date.now(),
  });
}

/**
 * Saving the user message that a queued row became removes the row in the
 * same transaction, so a reload or another device never sends it twice. A
 * server send keeps its row until its run is attached (`completeDispatch`):
 * the row holds the queue in order, and a failed start can return it.
 */
export async function retireQueuedMessage(
  ctx: MutationCtx,
  args: { id: string; chatId: string; userId: string },
) {
  const row = await findQueuedMessage(ctx, args.id);
  if (
    row &&
    row.chat_id === args.chatId &&
    row.user_id === args.userId &&
    !isDispatchClaimed(row, Date.now())
  )
    await ctx.db.delete(row._id);
}

/** True when the batch was full, so the caller deletes again. */
export async function deleteQueuedMessagesForChat(
  ctx: MutationCtx,
  chatId: string,
): Promise<boolean> {
  const rows = await ctx.db
    .query("queued_messages")
    .withIndex("by_chat_and_sent", (q) => q.eq("chat_id", chatId))
    .take(QUEUED_MESSAGE_DELETE_BATCH);
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length === QUEUED_MESSAGE_DELETE_BATCH;
}
