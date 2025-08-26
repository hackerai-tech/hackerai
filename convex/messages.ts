import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";

/**
 * Save a single message to a chat
 */
export const saveMessage = mutation({
  args: {
    serviceKey: v.optional(v.string()),
    id: v.string(),
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
      // Check if message already exists
      const existingMessage = await ctx.db
        .query("messages")
        .withIndex("by_message_id", (q) => q.eq("id", args.id))
        .first();

      if (existingMessage) {
        return null;
      }

      await ctx.db.insert("messages", {
        id: args.id,
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
      id: v.string(),
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
      // Verify chat ownership
      try {
        await ctx.runQuery(internal.chats.verifyChatOwnership, {
          chatId: args.chatId,
          userId: user.subject,
        });
      } catch (error) {
        // Chat doesn't exist yet - return empty array (will be created on first message)
        return [];
      }

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
    id: v.string(),
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
      // Verify chat ownership
      await ctx.runQuery(internal.chats.verifyChatOwnership, {
        chatId: args.chatId,
        userId: user.subject,
      });

      await ctx.db.insert("messages", {
        id: args.id,
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
      // Verify chat ownership
      await ctx.runQuery(internal.chats.verifyChatOwnership, {
        chatId: args.chatId,
        userId: user.subject,
      });

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

/**
 * Regenerate with new content by updating a message and deleting subsequent messages
 */
export const regenerateWithNewContent = mutation({
  args: {
    messageId: v.id("messages"),
    newContent: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new Error("Unauthorized: User not authenticated");
    }

    try {
      const message = await ctx.db
        .query("messages")
        .withIndex("by_id", (q) =>
          q.eq("_id", args.messageId as Id<"messages">),
        )
        .first();

      if (!message) {
        throw new Error("Message not found");
      }

      // Verify chat ownership
      await ctx.runQuery(internal.chats.verifyChatOwnership, {
        chatId: message.chat_id,
        userId: user.subject,
      });

      await ctx.db.patch(message._id, {
        parts: [{ type: "text", text: args.newContent }],
        update_time: Date.now(),
      });

      // Delete all messages after the given message
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) =>
          q
            .eq("chat_id", message.chat_id)
            .gt("_creationTime", message._creationTime),
        )
        .collect();

      for (const msg of messages) {
        await ctx.db.delete(msg._id);
      }

      return null;
    } catch (error) {
      console.error("Failed to regenerate with new content:", error);
      throw error;
    }
  },
});
