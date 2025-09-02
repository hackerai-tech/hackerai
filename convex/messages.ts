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
 * Save a single message to a chat
 */
export const saveMessage = mutation({
  args: {
    serviceKey: v.optional(v.string()),
    id: v.string(),
    chatId: v.string(),
    userId: v.string(),
    role: v.string(),
    parts: v.array(v.any()),
    fileIds: v.optional(v.array(v.id("files"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Verify service role key
    validateServiceKey(args.serviceKey);

    try {
      // Check if message already exists
      const existingMessage = await ctx.db
        .query("messages")
        .withIndex("by_message_id", (q) => q.eq("id", args.id))
        .first();

      if (existingMessage) {
        return null;
      } else {
        // Verify chat ownership
        await ctx.runQuery(internal.messages.verifyChatOwnership, {
          chatId: args.chatId,
          userId: args.userId,
        });
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
        // _id: v.id("messages"),
        // _creationTime: v.number(),
        id: v.string(),
        // chat_id: v.string(),
        // user_id: v.optional(v.string()),
        role: v.string(),
        parts: v.array(v.any()),
        // file_ids: v.optional(v.array(v.id("files"))),
        // feedback_id: v.optional(v.id("feedback")),
        // update_time: v.number(),
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
      // Verify chat ownership
      try {
        await ctx.runQuery(internal.messages.verifyChatOwnership, {
          chatId: args.chatId,
          userId: user.subject,
        });
      } catch (error) {
        // Chat doesn't exist yet - return empty results (will be created on first message)
        return {
          page: [],
          isDone: true,
          continueCursor: "",
        };
      }

      // For chat messages, we use descending order (newest first)
      // and let the client handle the display order
      const result = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
        .order("desc") // Newest first - this is correct for "load more" to get older messages
        .paginate(args.paginationOpts);

      // Enhance messages with feedback data for assistant messages
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

      // Re-throw authorization errors to trigger proper handling on client
      if (error instanceof Error && error.message.includes("Unauthorized")) {
        throw error;
      }

      // For other errors, return empty results to prevent breaking the UI
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
      await ctx.runQuery(internal.messages.verifyChatOwnership, {
        chatId: args.chatId,
        userId: user.subject,
      });

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
          await ctx.runQuery(internal.messages.verifyChatOwnership, {
            chatId: args.chatId,
            userId: user.subject,
          });
        }

        // Clean up files associated with this message
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
              // Continue with deletion even if file cleanup fails
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
        await ctx.runQuery(internal.messages.verifyChatOwnership, {
          chatId: message.chat_id,
          userId: user.subject,
        });
      }

      // Update message with new content and clear storage_ids since we're replacing with text
      await ctx.db.patch(message._id, {
        parts: [{ type: "text", text: args.newContent }],
        file_ids: undefined, // Clear file references when replacing with text
        update_time: Date.now(),
      });

      // Delete all messages after the given message and their associated files
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) =>
          q
            .eq("chat_id", message.chat_id)
            .gt("_creationTime", message._creationTime),
        )
        .collect();

      for (const msg of messages) {
        // Clean up files associated with this message
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
              // Continue with deletion even if file cleanup fails
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
