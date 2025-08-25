import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

/**
 * Save a single message to a chat
 */
export const saveMessage = mutation({
  args: {
    serviceKey: v.optional(v.string()),
    chatId: v.string(),
    role: v.string(),
    parts: v.array(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Verify service role key
    if (
      args.serviceKey &&
      args.serviceKey !== process.env.CONVEX_SERVICE_ROLE_KEY
    ) {
      throw new Error("Unauthorized: Invalid service key");
    }

    try {
      // Save the message
      await ctx.db.insert("messages", {
        chat_id: args.chatId,
        role: args.role,
        parts: args.parts,
        update_time: Date.now(),
      });

      return null;
    } catch (error) {
      console.error("Failed to save message:", error);
      throw new Error("Failed to save message");
    }
  },
});

/**
 * Get messages for a chat
 */
export const getMessagesByChatId = query({
  args: { chatId: v.string() },
  returns: v.array(
    v.object({
      _id: v.id("messages"),
      _creationTime: v.number(),
      chat_id: v.string(),
      role: v.string(),
      parts: v.array(v.any()),
      update_time: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new Error("Unauthorized: User not authenticated");
    }

    try {
      // First check if the chat exists and belongs to the user
      const chat = await ctx.db
        .query("chats")
        .withIndex("by_user_id")
        .filter((q) => q.eq(q.field("id"), args.chatId))
        .first();

      if (!chat) {
        // Chat doesn't exist yet - return empty array (will be created on first message)
        return [];
      }

      // Check if the chat belongs to the current user
      if (chat.user_id !== user.subject) {
        throw new Error("Unauthorized: Chat does not belong to user");
      }

      // Get messages for this chat
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
        .order("asc")
        .collect();

      return messages;
    } catch (error) {
      console.error("Failed to get messages:", error);

      // Re-throw authorization errors to trigger proper handling on client
      if (error instanceof Error && error.message.includes("Unauthorized")) {
        throw error;
      }

      // For other errors, return empty array to prevent breaking the UI
      return [];
    }
  },
});

/**
 * Save a message from the client (with authentication)
 */
export const saveMessageFromClient = mutation({
  args: {
    chatId: v.string(),
    role: v.string(),
    parts: v.array(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new Error("Unauthorized: User not authenticated");
    }

    try {
      // First check if the chat exists and belongs to the user
      const chat = await ctx.db
        .query("chats")
        .withIndex("by_user_id")
        .filter((q) => q.eq(q.field("id"), args.chatId))
        .first();

      if (!chat) {
        throw new Error("Chat not found");
      }

      // Check if the chat belongs to the current user
      if (chat.user_id !== user.subject) {
        throw new Error("Unauthorized: Chat does not belong to user");
      }

      // Save the message
      await ctx.db.insert("messages", {
        chat_id: args.chatId,
        role: args.role,
        parts: args.parts,
        update_time: Date.now(),
      });

      return null;
    } catch (error) {
      console.error("Failed to save message from client:", error);
      throw error;
    }
  },
});

/**
 * Delete the last assistant message from a chat
 */
export const deleteLastAssistantMessage = mutation({
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
      // Find the chat to verify it exists
      const chat = await ctx.db
        .query("chats")
        .withIndex("by_user_id")
        .filter((q) => q.eq(q.field("id"), args.chatId))
        .first();

      if (!chat) {
        throw new Error("Chat not found");
      }

      // Get the last assistant message for this chat
      const lastAssistantMessage = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
        .filter((q) => q.eq(q.field("role"), "assistant"))
        .order("desc")
        .first();

      if (lastAssistantMessage) {
        await ctx.db.delete(lastAssistantMessage._id);
      }

      return null;
    } catch (error) {
      console.error("Failed to delete last assistant message:", error);
      throw error;
    }
  },
});
