import { query, mutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { paginationOptsValidator } from "convex/server";
import { validateServiceKey } from "./chats";

export const verifyChatOwnership = internalQuery({
  args: {
    chatId: v.string(),
    userId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();

    if (!chat) {
      return false;
    } else if (chat.user_id !== args.userId) {
      throw new Error("Unauthorized: Chat does not belong to user");
    }

    return true;
  },
});

/**
 * Save a single message to a chat
 */
export const saveMessage = mutation({
  args: {
    serviceKey: v.optional(v.string()),
    id: v.string(),
    chatId: v.string(),
    userId: v.string(),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
    ),
    parts: v.array(v.any()),
    fileIds: v.optional(v.array(v.id("files"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    try {
      const existingMessage = await ctx.db
        .query("messages")
        .withIndex("by_message_id", (q) => q.eq("id", args.id))
        .first();

      if (existingMessage) {
        return null;
      } else {
        const chatExists: boolean = await ctx.runQuery(
          internal.messages.verifyChatOwnership,
          {
            chatId: args.chatId,
            userId: args.userId,
          },
        );

        if (!chatExists) {
          throw new Error("Chat not found");
        }
      }

      await ctx.db.insert("messages", {
        id: args.id,
        chat_id: args.chatId,
        user_id: args.userId,
        role: args.role,
        parts: args.parts,
        file_ids: args.fileIds,
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
 * Get messages for a chat with pagination
 */
export const getMessagesByChatId = query({
  args: {
    chatId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(
      v.object({
        id: v.string(),
        role: v.union(
          v.literal("user"),
          v.literal("assistant"),
          v.literal("system"),
        ),
        parts: v.array(v.any()),
        feedback: v.union(
          v.object({
            feedbackType: v.union(v.literal("positive"), v.literal("negative")),
          }),
          v.null(),
        ),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
    pageStatus: v.optional(v.union(v.string(), v.null())),
    splitCursor: v.optional(v.union(v.string(), v.null())),
  }),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new Error("Unauthorized: User not authenticated");
    }

    try {
      const chatExists: boolean = await ctx.runQuery(
        internal.messages.verifyChatOwnership,
        {
          chatId: args.chatId,
          userId: user.subject,
        },
      );

      if (!chatExists) {
        return {
          page: [],
          isDone: true,
          continueCursor: "",
        };
      }

      const result = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
        .order("desc")
        .paginate(args.paginationOpts);

      const enhancedMessages = [];
      for (const message of result.page) {
        if (message.role === "assistant" && message.feedback_id) {
          const feedback = await ctx.db.get(message.feedback_id);

          enhancedMessages.push({
            id: message.id,
            role: message.role,
            parts: message.parts,
            feedback: feedback
              ? {
                  feedbackType: feedback.feedback_type as
                    | "positive"
                    | "negative",
                }
              : null,
          });
        } else {
          enhancedMessages.push({
            id: message.id,
            role: message.role,
            parts: message.parts,
            feedback: null,
          });
        }
      }

      return {
        ...result,
        page: enhancedMessages,
      };
    } catch (error) {
      console.error("Failed to get messages:", error);

      if (error instanceof Error && error.message.includes("Unauthorized")) {
        throw error;
      }
      return {
        page: [],
        isDone: true,
        continueCursor: "",
      };
    }
  },
});

/**
 * Save a message from the client (with authentication)
 */
export const saveAssistantMessageFromClient = mutation({
  args: {
    id: v.string(),
    chatId: v.string(),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
    ),
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
      const chatExists: boolean = await ctx.runQuery(
        internal.messages.verifyChatOwnership,
        {
          chatId: args.chatId,
          userId: user.subject,
        },
      );

      if (!chatExists) {
        throw new Error("Chat not found");
      }

      await ctx.db.insert("messages", {
        id: args.id,
        chat_id: args.chatId,
        user_id: user.subject,
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
export const deleteLastAssistantMessageFromClient = mutation({
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
      const lastAssistantMessage = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
        .filter((q) => q.eq(q.field("role"), "assistant"))
        .order("desc")
        .first();

      if (lastAssistantMessage) {
        if (
          lastAssistantMessage.user_id &&
          lastAssistantMessage.user_id !== user.subject
        ) {
          throw new Error(
            "Unauthorized: User not allowed to delete this message",
          );
        } else {
          // Verify chat ownership
          const chatExists: boolean = await ctx.runQuery(
            internal.messages.verifyChatOwnership,
            {
              chatId: args.chatId,
              userId: user.subject,
            },
          );

          if (!chatExists) {
            throw new Error("Chat not found");
          }
        }

        if (
          lastAssistantMessage.file_ids &&
          lastAssistantMessage.file_ids.length > 0
        ) {
          for (const storageId of lastAssistantMessage.file_ids) {
            try {
              const file = await ctx.db.get(storageId);
              if (file) {
                await ctx.storage.delete(file.storage_id);
                await ctx.db.delete(file._id);
              }
            } catch (error) {
              console.error(`Failed to delete file ${storageId}:`, error);
            }
          }
        }

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
 * Get all messages for a chat from the backend (for AI processing)
 */
export const getMessagesByChatIdForBackend = query({
  args: {
    serviceKey: v.optional(v.string()),
    chatId: v.string(),
    userId: v.string(),
  },
  returns: v.array(
    v.object({
      id: v.string(),
      role: v.union(
        v.literal("user"),
        v.literal("assistant"),
        v.literal("system"),
      ),
      parts: v.array(v.any()),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    try {
      // Verify chat ownership - if chat doesn't exist, return empty array
      const chatExists: boolean = await ctx.runQuery(
        internal.messages.verifyChatOwnership,
        {
          chatId: args.chatId,
          userId: args.userId,
        },
      );

      if (!chatExists) {
        // Chat doesn't exist yet (new chat), return empty array
        return [];
      }

      const LIMIT = 32;
      // Get newest 32 messages and reverse for chronological AI processing
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
        .order("desc")
        .take(LIMIT);

      const chronologicalMessages = messages.reverse();

      return chronologicalMessages.map((message) => ({
        id: message.id,
        role: message.role,
        parts: message.parts,
      }));
    } catch (error) {
      console.error("Failed to get messages for backend:", error);

      if (error instanceof Error && error.message.includes("Unauthorized")) {
        throw error;
      }
      return [];
    }
  },
});

/**
 * Regenerate with new content by updating a message and deleting subsequent messages
 */
export const regenerateWithNewContentFromClient = mutation({
  args: {
    messageId: v.string(),
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
        .withIndex("by_message_id", (q) => q.eq("id", args.messageId))
        .first();

      if (!message) {
        throw new Error("Message not found");
      } else if (message.user_id && message.user_id !== user.subject) {
        throw new Error(
          "Unauthorized: User not allowed to regenerate this message",
        );
      } else {
        // Verify chat ownership
        const chatExists: boolean = await ctx.runQuery(
          internal.messages.verifyChatOwnership,
          {
            chatId: message.chat_id,
            userId: user.subject,
          },
        );

        if (!chatExists) {
          throw new Error("Chat not found");
        }
      }

      await ctx.db.patch(message._id, {
        parts: [{ type: "text", text: args.newContent }],
        file_ids: undefined,
        update_time: Date.now(),
      });

      const messages = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) =>
          q
            .eq("chat_id", message.chat_id)
            .gt("_creationTime", message._creationTime),
        )
        .collect();

      for (const msg of messages) {
        if (msg.file_ids && msg.file_ids.length > 0) {
          for (const fileId of msg.file_ids) {
            try {
              const file = await ctx.db.get(fileId);
              if (file) {
                await ctx.storage.delete(file.storage_id);
                await ctx.db.delete(file._id);
              }
            } catch (error) {
              console.error(`Failed to delete file ${fileId}:`, error);
            }
          }
        }

        await ctx.db.delete(msg._id);
      }

      return null;
    } catch (error) {
      console.error("Failed to regenerate with new content:", error);
      throw error;
    }
  },
});
