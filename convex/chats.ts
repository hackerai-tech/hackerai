import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";

export function validateServiceKey(serviceKey?: string): void {
  if (serviceKey && serviceKey !== process.env.CONVEX_SERVICE_ROLE_KEY) {
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
        v.union(v.literal("ask"), v.literal("agent")),
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
      update_time: v.number(),
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
  args: { serviceKey: v.optional(v.string()), id: v.string() },
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
        v.union(v.literal("ask"), v.literal("agent")),
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
      update_time: v.number(),
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
    serviceKey: v.optional(v.string()),
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
 */
export const updateChat = mutation({
  args: {
    serviceKey: v.optional(v.string()),
    chatId: v.string(),
    title: v.optional(v.string()),
    finishReason: v.optional(v.string()),
    defaultModelSlug: v.optional(v.union(v.literal("ask"), v.literal("agent"))),
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
        throw new Error("Chat not found");
      }

      // Prepare update object with only provided fields
      const updateData: {
        title?: string;
        finish_reason?: string;
        default_model_slug?: "ask" | "agent";
        todos?: Array<{
          id: string;
          content: string;
          status: "pending" | "in_progress" | "completed" | "cancelled";
          sourceMessageId?: string;
        }>;
        update_time: number;
      } = {
        update_time: Date.now(),
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
      throw new Error("Failed to update chat");
    }
  },
});

/**
 * Start a stream by setting active_stream_id and clearing canceled_at (backend only)
 * Atomic single mutation to avoid race with pre-clearing.
 */
export const startStream = mutation({
  args: {
    serviceKey: v.optional(v.string()),
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
 * Prepare chat for a new stream by clearing both active_stream_id and canceled_at (backend only)
 * Combines both operations in a single atomic mutation
 */
export const prepareForNewStream = mutation({
  args: {
    serviceKey: v.optional(v.string()),
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
 * Cancel a stream by setting canceled_at and clearing active_stream_id (backend only)
 * Combines both operations in a single atomic mutation
 */
export const cancelStream = mutation({
  args: {
    serviceKey: v.optional(v.string()),
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

    // Only patch if needed
    if (chat.active_stream_id !== undefined || chat.canceled_at === undefined) {
      await ctx.db.patch(chat._id, {
        active_stream_id: undefined,
        canceled_at: Date.now(),
        update_time: Date.now(),
      });
    }

    return null;
  },
});

/**
 * Get only the cancellation status for a chat (backend only)
 * Optimized for stream cancellation checks
 */
export const getCancellationStatus = query({
  args: { serviceKey: v.optional(v.string()), chatId: v.string() },
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
 * Get user's latest chats with pagination
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
      const result = await ctx.db
        .query("chats")
        .withIndex("by_user_and_updated", (q) =>
          q.eq("user_id", identity.subject),
        )
        .order("desc") // Most recent first
        .paginate(args.paginationOpts);

      // Transform the page data to include only needed fields
      return result;
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
      throw new Error("Unauthorized: User not authenticated");
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
        throw new Error("Unauthorized: Chat does not belong to user");
      }

      // Delete all messages and their associated files
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
        .collect();

      for (const message of messages) {
        // Clean up files associated with this message
        if (message.file_ids && message.file_ids.length > 0) {
          for (const storageId of message.file_ids) {
            try {
              const file = await ctx.db.get(storageId);
              if (file) {
                await ctx.storage.delete(file.storage_id);
                await ctx.db.delete(file._id);
              }
            } catch (error) {
              console.error(`Failed to delete file ${storageId}:`, error);
              // Continue with deletion even if file cleanup fails
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
      throw new Error("Unauthorized: User not authenticated");
    }

    try {
      // Find the chat
      const chat = await ctx.db
        .query("chats")
        .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
        .first();

      if (!chat) {
        throw new Error("Chat not found");
      } else if (chat.user_id !== user.subject) {
        throw new Error("Unauthorized: Chat does not belong to user");
      }

      // Validate the new title
      const trimmedTitle = args.newTitle.trim();
      if (!trimmedTitle) {
        throw new Error("Chat title cannot be empty");
      }

      if (trimmedTitle.length > 100) {
        throw new Error("Chat title cannot exceed 100 characters");
      }

      // Update the chat title
      await ctx.db.patch(chat._id, {
        title: trimmedTitle,
        update_time: Date.now(),
      });

      return null;
    } catch (error) {
      console.error("Failed to rename chat:", error);
      throw error;
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
      throw new Error("Unauthorized: User not authenticated");
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
          // Clean up files associated with this message
          if (message.file_ids && message.file_ids.length > 0) {
            for (const storageId of message.file_ids) {
              try {
                const file = await ctx.db.get(storageId);
                if (file) {
                  await ctx.storage.delete(file.storage_id);
                  await ctx.db.delete(file._id);
                }
              } catch (error) {
                console.error(`Failed to delete file ${storageId}:`, error);
                // Continue with deletion even if file cleanup fails
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
