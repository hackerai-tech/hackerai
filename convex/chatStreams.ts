import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { validateServiceKey } from "./lib/utils";

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
      throw new Error("Chat not found");
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
 * Set active Trigger.dev run ID for a chat (client). Used when starting an agent-long run
 * so the client can reconnect after reload by fetching a token for this run.
 */
export const setActiveTriggerRunId = mutation({
  args: {
    chatId: v.string(),
    runId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
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
      throw new ConvexError({
        code: "CHAT_NOT_FOUND",
        message: "Chat not found",
      });
    }

    if (chat.user_id !== identity.subject) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "Unauthorized: Chat does not belong to user",
      });
    }

    await ctx.db.patch(chat._id, {
      active_trigger_run_id: args.runId,
      update_time: Date.now(),
    });

    return null;
  },
});

/**
 * Clear active Trigger.dev run ID for a chat (client). Call when run completes, fails,
 * is canceled, or when user cancels.
 */
export const clearActiveTriggerRunId = mutation({
  args: {
    chatId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
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
      return null;
    }

    if (chat.user_id !== identity.subject) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "Unauthorized: Chat does not belong to user",
      });
    }

    if (chat.active_trigger_run_id !== undefined) {
      await ctx.db.patch(chat._id, {
        active_trigger_run_id: undefined,
        update_time: Date.now(),
      });
    }

    return null;
  },
});

/**
 * Clear active Trigger.dev run ID for a chat (backend only). Used by the agent-stream task at completion.
 */
export const clearActiveTriggerRunIdFromBackend = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();

    if (!chat) {
      return null;
    }

    if (chat.active_trigger_run_id !== undefined) {
      await ctx.db.patch(chat._id, {
        active_trigger_run_id: undefined,
        update_time: Date.now(),
      });
    }

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
      throw new Error("Chat not found");
    }

    // Only patch if either field needs to be cleared
    if (chat.active_stream_id !== undefined || chat.canceled_at !== undefined) {
      await ctx.db.patch(chat._id, {
        active_stream_id: undefined,
        canceled_at: undefined,
        update_time: Date.now(),
      });
    }

    return null;
  },
});

/**
 * Cancel a stream from the client (with auth check)
 * Client-callable version of cancelStream
 */
export const cancelStreamFromClient = mutation({
  args: {
    chatId: v.string(),
    skipSave: v.optional(v.boolean()),
  },
  returns: v.null(),
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
      throw new ConvexError({
        code: "CHAT_NOT_FOUND",
        message: "Chat not found",
      });
    }

    // Verify ownership
    if (chat.user_id !== identity.subject) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "Unauthorized: Chat does not belong to user",
      });
    }

    // Only patch if needed
    if (chat.active_stream_id !== undefined || chat.canceled_at === undefined) {
      await ctx.db.patch(chat._id, {
        active_stream_id: undefined,
        canceled_at: Date.now(),
        finish_reason: undefined,
        update_time: Date.now(),
      });
    }

    // Publish cancellation to Redis for instant backend notification
    // This runs async and doesn't block the mutation response
    await ctx.scheduler.runAfter(0, internal.redisPubsub.publishCancellation, {
      chatId: args.chatId,
      skipSave: args.skipSave,
    });

    return null;
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
