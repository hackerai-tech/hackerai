import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

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
    if (
      args.serviceKey &&
      args.serviceKey !== process.env.CONVEX_SERVICE_ROLE_KEY
    ) {
      throw new Error("Unauthorized: Invalid service key");
    }

    try {
      const chat = await ctx.db
        .query("chats")
        .withIndex("by_user_id")
        .filter((q) => q.eq(q.field("id"), args.id))
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
    if (
      args.serviceKey &&
      args.serviceKey !== process.env.CONVEX_SERVICE_ROLE_KEY
    ) {
      throw new Error("Unauthorized: Invalid service key");
    }

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
    if (
      args.serviceKey &&
      args.serviceKey !== process.env.CONVEX_SERVICE_ROLE_KEY
    ) {
      throw new Error("Unauthorized: Invalid service key");
    }

    try {
      // Find the chat by chatId
      const chat = await ctx.db
        .query("chats")
        .withIndex("by_user_id")
        .filter((q) => q.eq(q.field("id"), args.chatId))
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
 * Get user's latest chats
 */
export const getUserChats = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("chats"),
      _creationTime: v.number(),
      id: v.string(),
      title: v.string(),
      user_id: v.string(),
      update_time: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    try {
      const chats = await ctx.db
        .query("chats")
        .withIndex("by_user_id", (q) => q.eq("user_id", identity.subject))
        .order("desc")
        .take(28); // Limit to 28 most recent chats

      return chats.map((chat) => ({
        _id: chat._id,
        _creationTime: chat._creationTime,
        id: chat.id,
        title: chat.title,
        user_id: chat.user_id,
        update_time: chat.update_time,
      }));
    } catch (error) {
      console.error("Failed to get user chats:", error);
      return [];
    }
  },
});

/**
 * Update todos for a chat
 */
export const updateChatTodos = mutation({
  args: {
    serviceKey: v.optional(v.string()),
    chatId: v.string(),
    todos: v.array(
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
      // Find the chat by chatId
      const chat = await ctx.db
        .query("chats")
        .withIndex("by_user_id")
        .filter((q) => q.eq(q.field("id"), args.chatId))
        .first();

      if (!chat) {
        throw new Error("Chat not found");
      }

      // Update the chat with new todos
      await ctx.db.patch(chat._id, {
        todos: args.todos,
        update_time: Date.now(),
      });

      return null;
    } catch (error) {
      console.error("Failed to update chat todos:", error);
      throw new Error("Failed to update chat todos");
    }
  },
});
