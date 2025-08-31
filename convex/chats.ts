import { query, mutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";

export function validateServiceKey(serviceKey?: string): void {
  if (serviceKey && serviceKey !== process.env.CONVEX_SERVICE_ROLE_KEY) {
    throw new Error("Unauthorized: Invalid service key");
  }
}

export const verifyChatOwnership = internalQuery({
  args: {
    chatId: v.string(),
    userId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();

    if (!chat) {
      throw new Error("Chat not found");
    } else if (chat.user_id !== args.userId) {
      throw new Error("Unauthorized: Chat does not belong to user");
    }

    return null;
  },
});

/**
 * Get a chat by its ID
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
      console.error("Failed to get chat by id:", error);
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
        todos?: Array<{
          id: string;
          content: string;
          status: "pending" | "in_progress" | "completed" | "cancelled";
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
      // Verify chat ownership
      await ctx.runQuery(internal.chats.verifyChatOwnership, {
        chatId: args.chatId,
        userId: user.subject,
      });

      // Find the chat
      const chat = await ctx.db
        .query("chats")
        .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
        .first();

      if (!chat) {
        throw new Error("Chat not found");
      }

      // Delete all messages and their associated files
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
        .collect();

      for (const message of messages) {
        // Clean up files associated with this message
        if (message.storage_ids && message.storage_ids.length > 0) {
          for (const storageId of message.storage_ids) {
            try {
              await ctx.storage.delete(storageId);
            } catch (error) {
              console.error(`Failed to delete file ${storageId}:`, error);
              // Continue with deletion even if file cleanup fails
            }
          }
        }

        await ctx.db.delete(message._id);
      }

      // Delete the chat itself
      await ctx.db.delete(chat._id);

      return null;
    } catch (error) {
      console.error("Failed to delete chat:", error);
      throw error;
    }
  },
});
