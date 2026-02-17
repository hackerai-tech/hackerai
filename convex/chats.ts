import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import { fileCountAggregate } from "./fileAggregate";
import { MAX_PINNED_CHATS } from "./constants";

export function validateServiceKey(serviceKey: string): void {
  if (serviceKey !== process.env.CONVEX_SERVICE_ROLE_KEY) {
    throw new Error("Unauthorized: Invalid service key");
  }
}

/**
 * Get a chat by its ID
 */
export const getChatByIdFromClient = query({
  args: { id: v.string() },
  returns: v.union(
    v.object({
      _id: v.id("chats"),
      _creationTime: v.number(),
      id: v.string(),
      title: v.string(),
      user_id: v.string(),
      finish_reason: v.optional(v.string()),
      active_stream_id: v.optional(v.string()),
      canceled_at: v.optional(v.number()),
      default_model_slug: v.optional(
        v.union(v.literal("ask"), v.literal("agent"), v.literal("agent-long")),
      ),
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
      branched_from_chat_id: v.optional(v.string()),
      branched_from_title: v.optional(v.string()),
      latest_summary_id: v.optional(v.id("chat_summaries")),
      share_id: v.optional(v.string()),
      share_date: v.optional(v.number()),
      update_time: v.number(),
      pinned_at: v.optional(v.number()),
      active_trigger_run_id: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    try {
      // Enforce ownership: only return the chat for the authenticated owner
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) {
        return null;
      }

      const chat = await ctx.db
        .query("chats")
        .withIndex("by_chat_id", (q) => q.eq("id", args.id))
        .first();

      if (!chat) {
        return null;
      }

      if (chat.user_id !== identity.subject) {
        return null;
      }

      // Fetch branched_from_title if this chat is branched from another chat
      if (chat.branched_from_chat_id) {
        const branchedFromChat = await ctx.db
          .query("chats")
          .withIndex("by_chat_id", (q) =>
            q.eq("id", chat.branched_from_chat_id!),
          )
          .first();

        return {
          ...chat,
          branched_from_title: branchedFromChat?.title,
        };
      }

      return chat;
    } catch (error) {
      console.error("Failed to get chat by id:", error);
      return null;
    }
  },
});

/**
 * Backend: Get a chat by its ID using service key (no ctx.auth).
 * Used by server-side actions that already enforce ownership separately.
 */
export const getChatById = query({
  args: { serviceKey: v.string(), id: v.string() },
  returns: v.union(
    v.object({
      _id: v.id("chats"),
      _creationTime: v.number(),
      id: v.string(),
      title: v.string(),
      user_id: v.string(),
      finish_reason: v.optional(v.string()),
      active_stream_id: v.optional(v.string()),
      canceled_at: v.optional(v.number()),
      default_model_slug: v.optional(
        v.union(v.literal("ask"), v.literal("agent"), v.literal("agent-long")),
      ),
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
      branched_from_chat_id: v.optional(v.string()),
      latest_summary_id: v.optional(v.id("chat_summaries")),
      share_id: v.optional(v.string()),
      share_date: v.optional(v.number()),
      update_time: v.number(),
      pinned_at: v.optional(v.number()),
      active_trigger_run_id: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    // Verify service role key
    validateServiceKey(args.serviceKey);

    try {
      const chat = await ctx.db
        .query("chats")
        .withIndex("by_chat_id", (q) => q.eq("id", args.id))
        .first();

      return chat || null;
    } catch (error) {
      console.error("Failed to get chat by id (backend):", error);
      return null;
    }
  },
});

/**
 * Save a new chat
 */
export const saveChat = mutation({
  args: {
    serviceKey: v.string(),
    id: v.string(),
    userId: v.string(),
    title: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    // Verify service role key
    validateServiceKey(args.serviceKey);

    try {
      const chatId = await ctx.db.insert("chats", {
        id: args.id,
        title: args.title,
        user_id: args.userId,
        update_time: Date.now(),
      });

      return chatId;
    } catch (error) {
      console.error("Failed to save chat:", error);
      throw new Error("Failed to save chat");
    }
  },
});

/**
 * Update an existing chat with title and finish reason
 * Automatically clears active_stream_id and canceled_at for stream cleanup
 */
export const updateChat = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    title: v.optional(v.string()),
    finishReason: v.optional(v.string()),
    defaultModelSlug: v.optional(
      v.union(v.literal("ask"), v.literal("agent"), v.literal("agent-long")),
    ),
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
  returns: v.null(),
  handler: async (ctx, args) => {
    // Verify service role key
    validateServiceKey(args.serviceKey);

    try {
      // Find the chat by chatId
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

      // Prepare update object with only provided fields
      const updateData: {
        title?: string;
        finish_reason?: string;
        default_model_slug?: "ask" | "agent" | "agent-long";
        todos?: Array<{
          id: string;
          content: string;
          status: "pending" | "in_progress" | "completed" | "cancelled";
          sourceMessageId?: string;
        }>;
        active_stream_id?: undefined;
        canceled_at?: undefined;
        update_time: number;
      } = {
        update_time: Date.now(),
        // Always clear stream state when updating chat (stream is finished)
        active_stream_id: undefined,
        canceled_at: undefined,
      };

      if (args.title !== undefined) {
        updateData.title = args.title;
      }

      if (args.finishReason !== undefined) {
        updateData.finish_reason = args.finishReason;
      }

      if (args.defaultModelSlug !== undefined) {
        updateData.default_model_slug = args.defaultModelSlug;
      }

      if (args.todos !== undefined) {
        updateData.todos = args.todos;
      }

      // Update the chat
      await ctx.db.patch(chat._id, updateData);

      return null;
    } catch (error) {
      console.error("Failed to update chat:", error);
      throw error;
    }
  },
});

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

/**
 * Get user's latest chats with pagination. Pinned chats (max 3) appear first in pin order.
 */
export const getUserChats = query({
  args: {
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return {
        page: [],
        isDone: true,
        continueCursor: "",
      };
    }

    try {
      // Step 1: Fetch pinned chats only, ordered by pinned_at asc (first pinned = first in list)
      const pinnedChats = await ctx.db
        .query("chats")
        .withIndex("by_user_and_pinned", (q) =>
          q.eq("user_id", identity.subject).gt("pinned_at", 0),
        )
        .order("asc")
        .take(MAX_PINNED_CHATS);

      const pinnedIds = pinnedChats.map((c) => c.id);

      // Step 2: Fetch one page (no over-fetch: slicing would lose items permanently
      // because the cursor advances past all fetched items)
      const result = await ctx.db
        .query("chats")
        .withIndex("by_user_and_updated", (q) =>
          q.eq("user_id", identity.subject),
        )
        .order("desc")
        .paginate(args.paginationOpts);

      const unpinnedPage = result.page.filter((c) => !pinnedIds.includes(c.id));
      const isFirstPage =
        args.paginationOpts.cursor == null || args.paginationOpts.cursor === "";
      const combinedPage = isFirstPage
        ? [...pinnedChats, ...unpinnedPage]
        : unpinnedPage;

      // Step 3: Enhance all chats (pinned + unpinned) with branched_from_title
      // Step 3a: Collect unique branched_from_chat_ids
      const branchedIds = [
        ...new Set(
          combinedPage
            .map((chat) => chat.branched_from_chat_id)
            .filter((id): id is string => id != null),
        ),
      ];

      // Step 3b: Batch fetch all branched chats in parallel
      const branchedChats = await Promise.all(
        branchedIds.map((id) =>
          ctx.db
            .query("chats")
            .withIndex("by_chat_id", (q) => q.eq("id", id))
            .first(),
        ),
      );

      // Step 3c: Build lookup map for O(1) access
      const branchedChatMap = new Map(
        branchedChats
          .filter((chat): chat is NonNullable<typeof chat> => chat != null)
          .map((chat) => [chat.id, chat]),
      );

      // Step 4: Enhance chats using the map
      const enhancedChats = combinedPage.map((chat) => {
        if (chat.branched_from_chat_id) {
          const branchedFromChat = branchedChatMap.get(
            chat.branched_from_chat_id,
          );
          return {
            ...chat,
            branched_from_title: branchedFromChat?.title,
          };
        }
        return chat;
      });

      return {
        ...result,
        page: enhancedChats,
      };
    } catch (error) {
      console.error("Failed to get user chats:", error);
      return {
        page: [],
        isDone: true,
        continueCursor: "",
      };
    }
  },
});

/**
 * Pin a chat. Pinned chats appear at the top of the list. Max 3 pinned chats per user.
 */
export const pinChat = mutation({
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
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Chat not found",
      });
    }
    if (chat.user_id !== identity.subject) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "Unauthorized: Chat does not belong to user",
      });
    }
    if (chat.pinned_at != null) {
      return null; // Already pinned
    }

    const pinnedChats = await ctx.db
      .query("chats")
      .withIndex("by_user_and_pinned", (q) =>
        q.eq("user_id", identity.subject).gt("pinned_at", 0),
      )
      .take(MAX_PINNED_CHATS);

    if (pinnedChats.length >= MAX_PINNED_CHATS) {
      throw new ConvexError({
        code: "MAX_PINNED_REACHED",
        message: `You can pin at most ${MAX_PINNED_CHATS} chats`,
      });
    }

    await ctx.db.patch(chat._id, { pinned_at: Date.now() });
    return null;
  },
});

/**
 * Unpin a chat. It will appear at the top of the unpinned list (update_time is set to now).
 */
export const unpinChat = mutation({
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
      throw new ConvexError({
        code: "NOT_FOUND",
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
      pinned_at: undefined,
      update_time: Date.now(),
    });
    return null;
  },
});

/**
 * Delete a chat and all its messages
 */
export const deleteChat = mutation({
  args: {
    chatId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    try {
      // Find the chat
      const chat = await ctx.db
        .query("chats")
        .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
        .first();

      if (!chat) {
        return null;
      } else if (chat.user_id !== user.subject) {
        throw new ConvexError({
          code: "ACCESS_DENIED",
          message: "Unauthorized: Chat does not belong to user",
        });
      }

      // Delete all messages and their associated files
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
        .collect();

      for (const message of messages) {
        // Skip deleting files for copied messages (they reference original chat files)
        if (!message.source_message_id) {
          // Clean up files associated with this message
          if (message.file_ids && message.file_ids.length > 0) {
            for (const storageId of message.file_ids) {
              try {
                const file = await ctx.db.get(storageId);
                if (file) {
                  // Delete from appropriate storage
                  if (file.s3_key) {
                    await ctx.scheduler.runAfter(
                      0,
                      internal.s3Cleanup.deleteS3ObjectAction,
                      { s3Key: file.s3_key },
                    );
                  }
                  if (file.storage_id) {
                    await ctx.storage.delete(file.storage_id);
                  }
                  // Delete from aggregate
                  await fileCountAggregate.deleteIfExists(ctx, file);
                  await ctx.db.delete(file._id);
                }
              } catch (error) {
                console.error(`Failed to delete file ${storageId}:`, error);
                // Continue with deletion even if file cleanup fails
              }
            }
          }
        }

        // Clean up feedback associated with this message
        if (message.feedback_id) {
          try {
            await ctx.db.delete(message.feedback_id);
          } catch (error) {
            console.error(
              `Failed to delete feedback ${message.feedback_id}:`,
              error,
            );
            // Continue with deletion even if feedback cleanup fails
          }
        }

        await ctx.db.delete(message._id);
      }

      // Delete chat summaries
      if (chat.latest_summary_id) {
        try {
          await ctx.db.delete(chat.latest_summary_id);
        } catch (error) {
          console.error(
            `Failed to delete summary ${chat.latest_summary_id}:`,
            error,
          );
          // Continue with deletion even if summary cleanup fails
        }
      }

      // Delete all historical summaries for this chat
      const summaries = await ctx.db
        .query("chat_summaries")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
        .collect();

      for (const summary of summaries) {
        try {
          await ctx.db.delete(summary._id);
        } catch (error) {
          console.error(`Failed to delete summary ${summary._id}:`, error);
          // Continue with deletion even if summary cleanup fails
        }
      }

      // Delete the chat itself
      await ctx.db.delete(chat._id);

      return null;
    } catch (error) {
      console.error("Failed to delete chat:", error);
      // Avoid surfacing errors to the client; treat as a no-op
      return null;
    }
  },
});

/**
 * Rename a chat
 */
export const renameChat = mutation({
  args: {
    chatId: v.string(),
    newTitle: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    try {
      // Find the chat
      const chat = await ctx.db
        .query("chats")
        .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
        .first();

      if (!chat) {
        throw new ConvexError({
          code: "CHAT_NOT_FOUND",
          message: "Chat not found",
        });
      } else if (chat.user_id !== user.subject) {
        throw new ConvexError({
          code: "ACCESS_DENIED",
          message: "Unauthorized: Chat does not belong to user",
        });
      }

      // Validate the new title
      const trimmedTitle = args.newTitle.trim();
      if (!trimmedTitle) {
        throw new ConvexError({
          code: "VALIDATION_ERROR",
          message: "Chat title cannot be empty",
        });
      }

      if (trimmedTitle.length > 100) {
        throw new ConvexError({
          code: "VALIDATION_ERROR",
          message: "Chat title cannot exceed 100 characters",
        });
      }

      // Update the chat title
      await ctx.db.patch(chat._id, {
        title: trimmedTitle,
        update_time: Date.now(),
      });

      return null;
    } catch (error) {
      console.error("Failed to rename chat:", error);
      // Re-throw ConvexError as-is, wrap others
      if (error instanceof ConvexError) {
        throw error;
      }
      throw new ConvexError({
        code: "CHAT_RENAME_FAILED",
        message:
          error instanceof Error ? error.message : "Failed to rename chat",
      });
    }
  },
});

/**
 * Delete all chats for the authenticated user
 */
export const deleteAllChats = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    try {
      // Get all chats for the user
      const userChats = await ctx.db
        .query("chats")
        .withIndex("by_user_and_updated", (q) => q.eq("user_id", user.subject))
        .collect();

      // Delete each chat and its associated data
      for (const chat of userChats) {
        // Delete all messages and their associated files for this chat
        const messages = await ctx.db
          .query("messages")
          .withIndex("by_chat_id", (q) => q.eq("chat_id", chat.id))
          .collect();

        for (const message of messages) {
          // Skip deleting files for copied messages (they reference original chat files)
          if (!message.source_message_id) {
            // Clean up files associated with this message
            if (message.file_ids && message.file_ids.length > 0) {
              for (const storageId of message.file_ids) {
                try {
                  const file = await ctx.db.get(storageId);
                  if (file) {
                    // Delete from appropriate storage
                    if (file.s3_key) {
                      await ctx.scheduler.runAfter(
                        0,
                        internal.s3Cleanup.deleteS3ObjectAction,
                        { s3Key: file.s3_key },
                      );
                    }
                    if (file.storage_id) {
                      await ctx.storage.delete(file.storage_id);
                    }
                    // Delete from aggregate
                    await fileCountAggregate.deleteIfExists(ctx, file);
                    await ctx.db.delete(file._id);
                  }
                } catch (error) {
                  console.error(`Failed to delete file ${storageId}:`, error);
                  // Continue with deletion even if file cleanup fails
                }
              }
            }
          }

          // Clean up feedback associated with this message
          if (message.feedback_id) {
            try {
              await ctx.db.delete(message.feedback_id);
            } catch (error) {
              console.error(
                `Failed to delete feedback ${message.feedback_id}:`,
                error,
              );
              // Continue with deletion even if feedback cleanup fails
            }
          }

          await ctx.db.delete(message._id);
        }

        // Delete chat summaries
        if (chat.latest_summary_id) {
          try {
            await ctx.db.delete(chat.latest_summary_id);
          } catch (error) {
            console.error(
              `Failed to delete summary ${chat.latest_summary_id}:`,
              error,
            );
            // Continue with deletion even if summary cleanup fails
          }
        }

        // Delete all historical summaries for this chat
        const summaries = await ctx.db
          .query("chat_summaries")
          .withIndex("by_chat_id", (q) => q.eq("chat_id", chat.id))
          .collect();

        for (const summary of summaries) {
          try {
            await ctx.db.delete(summary._id);
          } catch (error) {
            console.error(`Failed to delete summary ${summary._id}:`, error);
            // Continue with deletion even if summary cleanup fails
          }
        }

        // Delete the chat itself
        await ctx.db.delete(chat._id);
      }

      return null;
    } catch (error) {
      console.error("Failed to delete all chats:", error);
      throw error;
    }
  },
});

/**
 * Delete all chats for a given user (service key only).
 * Used by scripts for test hygiene (e.g. after e2e runs).
 */
export const deleteAllChatsForUser = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const userChats = await ctx.db
      .query("chats")
      .withIndex("by_user_and_updated", (q) => q.eq("user_id", args.userId))
      .collect();

    for (const chat of userChats) {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", chat.id))
        .collect();

      for (const message of messages) {
        if (!message.source_message_id && message.file_ids?.length) {
          for (const storageId of message.file_ids) {
            try {
              const file = await ctx.db.get(storageId);
              if (file) {
                if (file.s3_key) {
                  await ctx.scheduler.runAfter(
                    0,
                    internal.s3Cleanup.deleteS3ObjectAction,
                    { s3Key: file.s3_key },
                  );
                }
                if (file.storage_id) {
                  await ctx.storage.delete(file.storage_id);
                }
                await fileCountAggregate.deleteIfExists(ctx, file);
                await ctx.db.delete(file._id);
              }
            } catch (error) {
              console.error(`Failed to delete file ${storageId}:`, error);
            }
          }
        }
        if (message.feedback_id) {
          try {
            await ctx.db.delete(message.feedback_id);
          } catch (error) {
            console.error(
              `Failed to delete feedback ${message.feedback_id}:`,
              error,
            );
          }
        }
        await ctx.db.delete(message._id);
      }

      if (chat.latest_summary_id) {
        try {
          await ctx.db.delete(chat.latest_summary_id);
        } catch (error) {
          console.error(
            `Failed to delete summary ${chat.latest_summary_id}:`,
            error,
          );
        }
      }

      const summaries = await ctx.db
        .query("chat_summaries")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", chat.id))
        .collect();
      for (const summary of summaries) {
        try {
          await ctx.db.delete(summary._id);
        } catch (error) {
          console.error(`Failed to delete summary ${summary._id}:`, error);
        }
      }

      await ctx.db.delete(chat._id);
    }

    return null;
  },
});

/**
 * Save conversation summary for a chat (backend only, agent mode)
 * Optimized: stores summary in separate table and references ID in chat
 */
export const saveLatestSummary = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    summaryText: v.string(),
    summaryUpToMessageId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Verify service role key
    validateServiceKey(args.serviceKey);

    try {
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

      // Delete old summary if it exists
      if (chat.latest_summary_id) {
        try {
          const summaryIdToDelete = chat.latest_summary_id;
          await ctx.db.patch(chat._id, {
            latest_summary_id: undefined,
            update_time: Date.now(),
          });
          await ctx.db.delete(summaryIdToDelete);
        } catch (error) {
          // Continue anyway - old summary cleanup is not critical
        }
      }

      // Insert new summary record
      const summaryId = await ctx.db.insert("chat_summaries", {
        chat_id: args.chatId,
        summary_text: args.summaryText,
        summary_up_to_message_id: args.summaryUpToMessageId,
      });

      // Update chat to reference the latest summary (fast ID lookup)
      await ctx.db.patch(chat._id, {
        latest_summary_id: summaryId,
        update_time: Date.now(),
      });

      return null;
    } catch (error) {
      console.error("Failed to save chat summary:", error);
      throw new Error("Failed to save chat summary");
    }
  },
});

/**
 * Get latest summary for a chat (backend only)
 * Optimized: 1 indexed query + 1 ID lookup (2 fast DB operations)
 */
export const getLatestSummaryForBackend = query({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
  },
  returns: v.union(
    v.object({
      summary_text: v.string(),
      summary_up_to_message_id: v.string(),
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

      if (!chat || !chat.latest_summary_id) {
        return null;
      }

      // Fast ID lookup (single document read)
      const summary = await ctx.db.get(chat.latest_summary_id);

      if (!summary) {
        return null;
      }

      return {
        summary_text: summary.summary_text,
        summary_up_to_message_id: summary.summary_up_to_message_id,
      };
    } catch (error) {
      console.error("Failed to get latest summary:", error);
      return null;
    }
  },
});

/**
 * Share a chat by creating a public share link.
 * If the chat is already shared, returns the existing share_id.
 *
 * @param chatId - The ID of the chat to share
 * @returns Share metadata (shareId and shareDate)
 * @throws {Error} If chat not found or user not authorized
 */
export const shareChat = mutation({
  args: { chatId: v.string() },
  returns: v.object({
    shareId: v.string(),
    shareDate: v.number(),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: User not authenticated");
    }

    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();

    if (!chat) {
      throw new Error("Chat not found");
    }

    if (chat.user_id !== identity.subject) {
      throw new Error("Unauthorized: Chat does not belong to user");
    }

    // If already shared, return existing share_id
    if (chat.share_id && chat.share_date) {
      return {
        shareId: chat.share_id,
        shareDate: chat.share_date,
      };
    }

    // Generate new share_id using crypto.randomUUID() for security
    const shareId = crypto.randomUUID();
    const shareDate = Date.now();

    await ctx.db.patch(chat._id, {
      share_id: shareId,
      share_date: shareDate,
      update_time: Date.now(),
    });

    // Re-fetch to ensure we return the persisted value, handling potential race conditions
    const persisted = await ctx.db.get(chat._id);
    if (!persisted?.share_id || !persisted.share_date) {
      throw new Error("Failed to persist share metadata");
    }

    return {
      shareId: persisted.share_id,
      shareDate: persisted.share_date,
    };
  },
});

/**
 * Update an existing share by refreshing the share_date.
 * This allows the shared link to include new messages added after the original share.
 *
 * FROZEN SHARE CONCEPT:
 * - Original share shows messages up to original share_date
 * - After updating, shared link shows messages up to new share_date
 * - This gives users control over what content is publicly visible
 *
 * @param chatId - The ID of the chat to update
 * @returns Updated share metadata (same shareId, new shareDate)
 * @throws {Error} If chat not found, not shared, or user not authorized
 */
export const updateShareDate = mutation({
  args: { chatId: v.string() },
  returns: v.object({
    shareId: v.string(),
    shareDate: v.number(),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: User not authenticated");
    }

    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();

    if (!chat) {
      throw new Error("Chat not found");
    }

    if (chat.user_id !== identity.subject) {
      throw new Error("Unauthorized: Chat does not belong to user");
    }

    // Can only update if chat is already shared
    if (!chat.share_id || !chat.share_date) {
      throw new Error(
        "Chat is not shared - use shareChat to create a share first",
      );
    }

    // Update share_date to now, keeping same share_id
    const newShareDate = Date.now();

    await ctx.db.patch(chat._id, {
      share_date: newShareDate,
      update_time: Date.now(),
    });

    return {
      shareId: chat.share_id,
      shareDate: newShareDate,
    };
  },
});

/**
 * Unshare a chat by removing public access.
 *
 * @param chatId - The ID of the chat to unshare
 * @throws {Error} If chat not found or user not authorized
 */
export const unshareChat = mutation({
  args: { chatId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: User not authenticated");
    }

    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();

    if (!chat) {
      throw new Error("Chat not found");
    }

    if (chat.user_id !== identity.subject) {
      throw new Error("Unauthorized: Chat does not belong to user");
    }

    await ctx.db.patch(chat._id, {
      share_id: undefined,
      share_date: undefined,
      update_time: Date.now(),
    });

    return null;
  },
});

/**
 * Get shared chat by share_id (PUBLIC - no auth required).
 * Returns chat without user_id to maintain anonymity.
 *
 * @param shareId - The public share ID
 * @returns Chat data without sensitive user information, or null if not found
 */
export const getSharedChat = query({
  args: { shareId: v.string() },
  returns: v.union(
    v.object({
      _id: v.id("chats"),
      id: v.string(),
      title: v.string(),
      share_id: v.string(),
      share_date: v.number(),
      update_time: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_share_id", (q) => q.eq("share_id", args.shareId))
      .first();

    if (!chat || !chat.share_id || !chat.share_date) {
      return null;
    }

    // Return chat without user_id for anonymity
    return {
      _id: chat._id,
      id: chat.id,
      title: chat.title,
      share_id: chat.share_id,
      share_date: chat.share_date,
      update_time: chat.update_time,
    };
  },
});

/**
 * Get all shared chats for the authenticated user.
 *
 * @returns Array of shared chats with share metadata
 */
export const getUserSharedChats = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("chats"),
      id: v.string(),
      title: v.string(),
      share_id: v.string(),
      share_date: v.number(),
      update_time: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    const chats = await ctx.db
      .query("chats")
      .withIndex("by_user_and_updated", (q) =>
        q.eq("user_id", identity.subject),
      )
      .collect();

    // Filter and map to only shared chats
    return chats
      .filter((chat) => chat.share_id && chat.share_date)
      .map((chat) => ({
        _id: chat._id,
        id: chat.id,
        title: chat.title,
        share_id: chat.share_id!,
        share_date: chat.share_date!,
        update_time: chat.update_time,
      }))
      .sort((a, b) => b.share_date - a.share_date); // Most recent first
  },
});

/**
 * Unshare all chats for the authenticated user.
 *
 * @throws {Error} If user not authenticated
 */
export const unshareAllChats = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: User not authenticated");
    }

    const sharedChats = await ctx.db
      .query("chats")
      .withIndex("by_user_and_updated", (q) =>
        q.eq("user_id", identity.subject),
      )
      .collect();

    const updates = sharedChats
      .filter((chat) => chat.share_id)
      .map((chat) =>
        ctx.db.patch(chat._id, {
          share_id: undefined,
          share_date: undefined,
          update_time: Date.now(),
        }),
      );

    await Promise.all(updates);

    return null;
  },
});
