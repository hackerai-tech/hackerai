import { query, mutation } from "./lib/serviceFunctions";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { validateServiceKey } from "./lib/utils";
import { convexLogger } from "./lib/logger";
import { assertChatHistoryOwner } from "./lib/chatHistoryAccess";
import { assertUserCanAccessChatHistory } from "./lib/suspensionGuards";

const USER_STOP_NEWER_MESSAGE_LIMIT = 8;

/**
 * Start a stream by setting active_stream_id and clearing canceled_at (backend only)
 * Atomic single mutation to avoid race with pre-clearing.
 */
export const startStream = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    streamId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Verify service role key
    validateServiceKey(args.serviceKey);

    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();

    if (!chat) {
      convexLogger.warn("chat_stream_start_chat_missing", {
        chat_id: args.chatId,
        stream_id: args.streamId,
      });
      return null;
    }

    await ctx.db.patch(chat._id, {
      active_stream_id: args.streamId,
      canceled_at: undefined,
      update_time: Date.now(),
    });

    return null;
  },
});

/**
 * Prepare chat for a new stream by clearing both active_stream_id and canceled_at (backend only)
 * Combines both operations in a single atomic mutation
 */
export const prepareForNewStream = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    expectedActiveTriggerRunId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Verify service role key
    validateServiceKey(args.serviceKey);

    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();

    if (!chat) {
      convexLogger.warn("chat_stream_prepare_chat_missing", {
        chat_id: args.chatId,
      });
      return null;
    }

    if (
      args.expectedActiveTriggerRunId !== undefined &&
      chat.active_trigger_run_id !== args.expectedActiveTriggerRunId
    )
      return null;

    // Only patch if either field needs to be cleared. If a stream was active,
    // this is its terminal cleanup, so record the finish time in the same write.
    // Don't bump update_time; startStream already did that.
    if (chat.active_stream_id !== undefined || chat.canceled_at !== undefined) {
      await ctx.db.patch(chat._id, {
        active_stream_id: undefined,
        canceled_at: undefined,
        ...(chat.active_stream_id !== undefined
          ? { last_run_finished_at: Date.now() }
          : {}),
      });
    }

    return null;
  },
});

/**
 * Cancel a stream from the client (with auth check)
 * Client-callable version of cancelStream. Returns true only when this call
 * ended an active stream, so callers can tell a real Stop from a no-op.
 */
export const cancelStreamFromClient = mutation({
  args: {
    chatId: v.string(),
    skipSave: v.optional(v.boolean()),
    todos: v.optional(
      v.array(
        v.object({
          id: v.string(),
          content: v.string(),
          status: v.union(
            v.literal("pending"),
            v.literal("in_progress"),
            v.literal("completed"),
            v.literal("cancelled"),
          ),
          sourceMessageId: v.optional(v.string()),
        }),
      ),
    ),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    // Authenticate user
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();

    if (!chat) {
      // Benign race: chat was deleted before cancel arrived. Nothing to do.
      return false;
    }

    // Verify ownership
    if (chat.user_id !== identity.subject) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "Unauthorized: Chat does not belong to user",
      });
    }

    const wasRunning = chat.active_stream_id !== undefined;
    const shouldMarkCanceled = wasRunning || chat.canceled_at === undefined;

    // Persist the client todo snapshot with the cancellation so an immediate
    // steer cannot reload the older stored list before the interrupted run
    // finishes its normal todo persistence path.
    if (shouldMarkCanceled || args.todos !== undefined) {
      const canceledAt = Date.now();
      await ctx.db.patch(chat._id, {
        ...(shouldMarkCanceled
          ? {
              active_stream_id: undefined,
              canceled_at: canceledAt,
              finish_reason: undefined,
              update_time: canceledAt,
              ...(wasRunning ? { last_run_finished_at: canceledAt } : {}),
            }
          : {}),
        ...(args.todos !== undefined ? { todos: args.todos } : {}),
      });
    }

    // Publish cancellation to Redis for instant backend notification
    // This runs async and doesn't block the mutation response
    await ctx.scheduler.runAfter(0, internal.redisPubsub.publishCancellation, {
      chatId: args.chatId,
      skipSave: args.skipSave,
    });

    return wasRunning;
  },
});

/**
 * Record that an explicit Stop ended this turn. The client calls this only
 * after its cancellation was acknowledged; this re-checks that the anchor is
 * still the chat's latest turn and did not already finish on its own.
 * Returns whether the marker is saved. Idempotent.
 */
export const markMessageUserStopped = mutation({
  args: {
    chatId: v.string(),
    messageId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }
    await assertUserCanAccessChatHistory(ctx, identity.subject);

    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();
    if (!chat) return false;
    if (chat.user_id !== identity.subject) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "Unauthorized: Chat does not belong to user",
      });
    }
    await assertChatHistoryOwner(ctx, args.chatId, identity.subject);

    const message = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("id", args.messageId))
      .first();
    if (
      !message ||
      message.chat_id !== args.chatId ||
      message.user_id !== identity.subject ||
      message.role !== args.role ||
      message.is_hidden === true
    )
      return false;
    if (message.user_stopped === true) return true;
    // Both workers clear the finish reason for a user abort. A saved reason
    // belongs to a different terminal outcome, including automatic limits.
    if (message.role === "assistant" && message.finish_reason) return false;

    // Check only messages written after the anchor. Older tool results can be
    // large and cannot make this Stop stale.
    const newerMessages = await ctx.db
      .query("messages")
      .withIndex("by_chat_id", (q) =>
        q.eq("chat_id", args.chatId).gt("_creationTime", message._creationTime),
      )
      .take(USER_STOP_NEWER_MESSAGE_LIMIT);
    if (
      newerMessages.length === USER_STOP_NEWER_MESSAGE_LIMIT ||
      newerMessages.some((row) => !row.is_hidden && row.role !== "system")
    )
      return false;

    await ctx.db.patch(message._id, { user_stopped: true });
    return true;
  },
});

/**
 * Get only the cancellation status for a chat (backend only)
 * Optimized for stream cancellation checks
 */
export const getCancellationStatus = query({
  args: { serviceKey: v.string(), chatId: v.string() },
  returns: v.union(
    v.object({
      canceled_at: v.optional(v.number()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    // Verify service role key
    validateServiceKey(args.serviceKey);

    try {
      const chat = await ctx.db
        .query("chats")
        .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
        .first();

      if (!chat) {
        return null;
      }

      return {
        canceled_at: chat.canceled_at,
      };
    } catch (error) {
      console.error("Failed to get cancellation status:", error);
      return null;
    }
  },
});
