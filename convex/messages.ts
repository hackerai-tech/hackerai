import { query, mutation, internalQuery } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { validateServiceKey } from "./lib/utils";
import { fileCountAggregate } from "./fileAggregate";

/**
 * Extract text content from message parts for search and display
 */
const extractTextFromParts = (parts: any[]): string => {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text || "")
    .join(" ")
    .trim();
};

/**
 * Helper function to check if deleted messages invalidate the chat summary
 * Clears latest_summary_id if the summary's cutoff message was deleted
 */
const tryFallbackSummary = async (
  ctx: any,
  summaryId: Id<"chat_summaries">,
  previousSummaries: {
    summary_text: string;
    summary_up_to_message_id: string;
  }[],
  earliestDeletedTime: number,
): Promise<boolean> => {
  // Batch-fetch all cutoff messages in one pass
  const cutoffMessages = await Promise.all(
    previousSummaries.map((s) =>
      ctx.db
        .query("messages")
        .withIndex("by_message_id", (q: any) =>
          q.eq("id", s.summary_up_to_message_id),
        )
        .first(),
    ),
  );

  // Find the first candidate whose cutoff message still exists and predates the deletion
  for (let i = 0; i < previousSummaries.length; i++) {
    const cutoffMsg = cutoffMessages[i];
    if (cutoffMsg && cutoffMsg._creationTime < earliestDeletedTime) {
      await ctx.db.patch(summaryId, {
        summary_text: previousSummaries[i].summary_text,
        summary_up_to_message_id:
          previousSummaries[i].summary_up_to_message_id,
        previous_summaries: previousSummaries.slice(i + 1),
      });
      return true;
    }
  }
  return false;
};

const checkAndInvalidateSummary = async (
  ctx: any,
  chatId: string,
  deletedMessages: { id: string; creationTime: number }[],
) => {
  if (deletedMessages.length === 0) return;

  try {
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q: any) => q.eq("id", chatId))
      .first();

    if (!chat || !chat.latest_summary_id) return;

    const summary = await ctx.db.get(chat.latest_summary_id);
    if (!summary) return;

    const previousSummaries: {
      summary_text: string;
      summary_up_to_message_id: string;
    }[] = summary.previous_summaries ?? [];

    const earliestDeletedTime = Math.min(
      ...deletedMessages.map((m) => m.creationTime),
    );

    const cutoffMessage = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q: any) =>
        q.eq("id", summary.summary_up_to_message_id),
      )
      .first();

    if (!cutoffMessage) {
      const found = await tryFallbackSummary(
        ctx,
        chat.latest_summary_id,
        previousSummaries,
        earliestDeletedTime,
      );
      if (found) return;

      await ctx.db.patch(chat._id, {
        latest_summary_id: undefined,
        update_time: Date.now(),
      });
      try {
        await ctx.db.delete(chat.latest_summary_id);
      } catch (error) {
        console.error("[Messages] Failed to delete orphaned summary:", error);
      }
      return;
    }

    const shouldInvalidate = deletedMessages.some(
      (msg) => msg.creationTime <= cutoffMessage._creationTime,
    );

    if (shouldInvalidate) {
      const found = await tryFallbackSummary(
        ctx,
        chat.latest_summary_id,
        previousSummaries,
        earliestDeletedTime,
      );
      if (found) return;

      await ctx.db.patch(chat._id, {
        latest_summary_id: undefined,
        update_time: Date.now(),
      });
      try {
        await ctx.db.delete(chat.latest_summary_id);
      } catch (error) {
        console.error("[Messages] Failed to delete stale summary:", error);
      }
    }
  } catch (error) {
    console.error("[Messages] Failed to check/invalidate summary:", error);
  }
};

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
      throw new ConvexError({
        code: "CHAT_NOT_FOUND",
        message: "This chat doesn't exist",
      });
    } else if (chat.user_id !== args.userId) {
      throw new ConvexError({
        code: "CHAT_UNAUTHORIZED",
        message: "You don't have permission to access this chat",
      });
    }

    return true;
  },
});

/**
 * Save a single message to a chat
 */
export const saveMessage = mutation({
  args: {
    serviceKey: v.string(),
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
    model: v.optional(v.string()),
    generationTimeMs: v.optional(v.number()),
    finishReason: v.optional(v.string()),
    usage: v.optional(v.any()),
    updateOnly: v.optional(v.boolean()),
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
        // Build patch for fields that need updating
        const patch: Record<string, unknown> = {};

        // Add new fileIds if provided
        if (args.fileIds && args.fileIds.length > 0) {
          const currentFileIds = existingMessage.file_ids || [];
          const newFileIds = args.fileIds.filter(
            (id) => !currentFileIds.includes(id),
          );

          if (newFileIds.length > 0) {
            patch.file_ids = [...currentFileIds, ...newFileIds];

            // Mark new files as linked
            for (const fileId of newFileIds) {
              try {
                const file = await ctx.db.get(fileId);
                if (file && !file.is_attached) {
                  await ctx.db.patch(file._id, { is_attached: true });
                }
              } catch (error) {
                console.error(
                  `Failed to mark file ${fileId} as attached:`,
                  error,
                );
              }
            }
          }
        }

        // Update usage if provided and not already set (e.g., on abort)
        if (args.usage && !existingMessage.usage) {
          patch.usage = args.usage;
        }

        // Update metrics if provided and not already set
        if (args.model && !existingMessage.model) {
          patch.model = args.model;
        }
        if (args.generationTimeMs && !existingMessage.generation_time_ms) {
          patch.generation_time_ms = args.generationTimeMs;
        }
        if (args.finishReason && !existingMessage.finish_reason) {
          patch.finish_reason = args.finishReason;
        }

        // Apply patch if there are changes
        if (Object.keys(patch).length > 0) {
          patch.update_time = Date.now();
          await ctx.db.patch(existingMessage._id, patch);
        }

        return null;
      } else {
        // updateOnly: only patch existing messages, don't create new ones.
        // Safety net for aborted streams when Redis skipSave signal was missed.
        if (args.updateOnly) {
          return null;
        }

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

      const content = extractTextFromParts(args.parts);

      await ctx.db.insert("messages", {
        id: args.id,
        chat_id: args.chatId,
        user_id: args.userId,
        role: args.role,
        parts: args.parts,
        content: content || undefined,
        file_ids: args.fileIds,
        update_time: Date.now(),
        model: args.model,
        generation_time_ms: args.generationTimeMs,
        finish_reason: args.finishReason,
        usage: args.usage,
      });

      // Mark attached files as linked so purge won't remove them
      if (args.fileIds && args.fileIds.length > 0) {
        for (const fileId of args.fileIds) {
          try {
            const file = await ctx.db.get(fileId);
            if (!file) {
              console.warn("File not found while marking attached:", fileId);
              continue;
            }
            if (file.user_id !== args.userId) {
              console.warn("Skipping file not owned by user:", fileId);
              continue;
            }
            await ctx.db.patch(fileId, { is_attached: true });
          } catch (e) {
            console.warn("Failed to mark file as attached:", fileId, e);
          }
        }
      }

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
        source_message_id: v.optional(v.string()),
        feedback: v.union(
          v.object({
            feedbackType: v.union(v.literal("positive"), v.literal("negative")),
          }),
          v.null(),
        ),
        fileDetails: v.optional(
          v.array(
            v.object({
              fileId: v.id("files"),
              name: v.string(),
              mediaType: v.optional(v.string()),
              url: v.optional(v.union(v.string(), v.null())),
              storageId: v.optional(v.string()),
              s3Key: v.optional(v.string()),
            }),
          ),
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
      return {
        page: [],
        isDone: true,
        continueCursor: "",
      };
    }

    try {
      await ctx.runQuery(internal.messages.verifyChatOwnership, {
        chatId: args.chatId,
        userId: user.subject,
      });

      const result = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
        .order("desc")
        .paginate(args.paginationOpts);

      // OPTIMIZATION: Batch fetch all files and URLs upfront to avoid N+1 queries

      // Step 1: Collect all unique file IDs from all messages
      const allFileIds = new Set<Id<"files">>();
      for (const message of result.page) {
        if (message.file_ids && message.file_ids.length > 0) {
          message.file_ids.forEach((id) => allFileIds.add(id));
        }
      }

      // Step 2: Batch fetch all files in parallel
      const fileIdArray = Array.from(allFileIds);
      const files = await Promise.all(
        fileIdArray.map((fileId) => ctx.db.get(fileId)),
      );

      // Step 3: Build file details lookup map for O(1) access
      // DON'T generate URLs here - they expire and get cached with the query!
      // Frontend will fetch URLs on-demand via actions (avoids stale cached URLs)
      // V8-SAFE: This query does NOT call generateS3DownloadUrl or any Node.js built-ins.
      // Only file metadata (fileId, name, mediaType, s3Key, storageId) is returned.
      const fileDetailsMap = new Map();
      files.forEach((file, index) => {
        if (file) {
          fileDetailsMap.set(fileIdArray[index], {
            fileId: fileIdArray[index],
            name: file.name,
            mediaType: file.media_type,
            // url: removed - generate on-demand to avoid caching expired URLs
            storageId: file.storage_id,
            s3Key: file.s3_key,
          });
        }
      });

      // Step 5: Build enhanced messages using the lookup map
      const enhancedMessages = [];
      for (const message of result.page) {
        // Get feedback if exists
        let feedback = null;
        if (message.role === "assistant" && message.feedback_id) {
          const feedbackDoc = await ctx.db.get(message.feedback_id);
          if (feedbackDoc) {
            feedback = {
              feedbackType: feedbackDoc.feedback_type as
                | "positive"
                | "negative",
            };
          }
        }

        // Get file details using O(1) lookup
        let fileDetails = undefined;
        if (message.file_ids && message.file_ids.length > 0) {
          fileDetails = message.file_ids
            .map((fileId) => fileDetailsMap.get(fileId))
            .filter((detail) => detail !== undefined);
        }

        enhancedMessages.push({
          id: message.id,
          role: message.role,
          parts: message.parts,
          source_message_id: message.source_message_id,
          feedback,
          fileDetails,
        });
      }

      return {
        ...result,
        page: enhancedMessages,
      };
    } catch (error) {
      // Handle chat access errors gracefully - return empty results without logging
      if (
        error instanceof ConvexError &&
        (error.data?.code === "CHAT_NOT_FOUND" ||
          error.data?.code === "CHAT_UNAUTHORIZED")
      ) {
        return {
          page: [],
          isDone: true,
          continueCursor: "",
        };
      }

      // Log unexpected errors only
      console.error("Failed to get messages:", error);

      // Re-throw other ConvexErrors for frontend handling
      if (error instanceof ConvexError) {
        throw error;
      }

      // For other errors, return empty page
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
export const saveAssistantMessage = mutation({
  args: {
    id: v.string(),
    chatId: v.string(),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
    ),
    parts: v.array(v.any()),
    model: v.optional(v.string()),
    generationTimeMs: v.optional(v.number()),
    finishReason: v.optional(v.string()),
    usage: v.optional(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new Error("Unauthorized: User not authenticated");
    }

    try {
      // Deduplicate by message id to avoid duplicates when stop is clicked multiple times
      const existing = await ctx.db
        .query("messages")
        .withIndex("by_message_id", (q) => q.eq("id", args.id))
        .first();
      if (existing) {
        return null;
      }

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

      // Save parts as-is - fixing happens at read time in chat-processor.ts
      const content = extractTextFromParts(args.parts);

      await ctx.db.insert("messages", {
        id: args.id,
        chat_id: args.chatId,
        user_id: user.subject,
        role: args.role,
        parts: args.parts,
        content: content || undefined,
        update_time: Date.now(),
        model: args.model,
        generation_time_ms: args.generationTimeMs,
        finish_reason: args.finishReason,
        usage: args.usage,
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

        // Check summary invalidation before deleting the message
        await checkAndInvalidateSummary(ctx, args.chatId, [
          {
            id: lastAssistantMessage.id,
            creationTime: lastAssistantMessage._creationTime,
          },
        ]);

        if (
          lastAssistantMessage.file_ids &&
          lastAssistantMessage.file_ids.length > 0
        ) {
          for (const storageId of lastAssistantMessage.file_ids) {
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
                } else if (file.storage_id) {
                  await ctx.storage.delete(file.storage_id);
                }
                // Delete from aggregate
                await fileCountAggregate.deleteIfExists(ctx, file);
                await ctx.db.delete(file._id);
              }
            } catch (error) {
              console.error(`Failed to delete file ${storageId}:`, error);
            }
          }
        }

        await ctx.db.delete(lastAssistantMessage._id);
      }

      // Update todos in the same transaction if provided
      if (args.todos !== undefined) {
        const chat = await ctx.db
          .query("chats")
          .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
          .first();

        if (chat && chat.user_id === user.subject) {
          await ctx.db.patch(chat._id, {
            todos: args.todos,
            update_time: Date.now(),
          });
        }
      }

      return null;
    } catch (error) {
      console.error("Failed to delete last assistant message:", error);
      throw error;
    }
  },
});

/**
 * Get only the most recent assistant message for stream replay
 */
export const getLastAssistantMessage = query({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
  },
  returns: v.union(
    v.object({
      id: v.string(),
      role: v.literal("assistant"),
      parts: v.array(v.any()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    try {
      const chatExists: boolean = await ctx.runQuery(
        internal.messages.verifyChatOwnership,
        { chatId: args.chatId, userId: args.userId },
      );

      if (!chatExists) return null;

      const message = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
        .order("desc")
        .first();

      if (!message || message.role !== "assistant") {
        return null;
      }

      return {
        id: message.id,
        role: message.role,
        parts: message.parts,
      };
    } catch (error) {
      console.error("Failed to get last assistant message:", error);
      return null;
    }
  },
});

/**
 * Get a page of messages for backend processing (adaptive backfill)
 */
export const getMessagesPageForBackend = query({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
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
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    // Verify chat ownership - if chat doesn't exist, return empty page
    const chatExists: boolean = await ctx.runQuery(
      internal.messages.verifyChatOwnership,
      {
        chatId: args.chatId,
        userId: args.userId,
      },
    );

    if (!chatExists) {
      return { page: [], isDone: true, continueCursor: "" };
    }

    const result = await ctx.db
      .query("messages")
      .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      page: result.page.map((message) => ({
        id: message.id,
        role: message.role,
        parts: message.parts,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/**
 * Search messages by content and chat titles with full text search
 */
export const searchMessages = query({
  args: {
    searchQuery: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(
      v.object({
        id: v.string(),
        chat_id: v.string(),
        content: v.string(),
        created_at: v.number(),
        updated_at: v.optional(v.number()),
        chat_title: v.optional(v.string()),
        match_type: v.union(
          v.literal("message"),
          v.literal("title"),
          v.literal("both"),
        ),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new Error("Unauthorized: User not authenticated");
    }

    if (!args.searchQuery.trim()) {
      return {
        page: [],
        isDone: true,
        continueCursor: "",
      };
    }

    try {
      // Search messages by content
      const messageResults = await ctx.db
        .query("messages")
        .withSearchIndex("search_content", (q) =>
          q.search("content", args.searchQuery).eq("user_id", user.subject),
        )
        .collect();

      // Search chats by title
      const chatResults = await ctx.db
        .query("chats")
        .withSearchIndex("search_title", (q) =>
          q.search("title", args.searchQuery).eq("user_id", user.subject),
        )
        .collect();

      // Create a map to track which chats have message matches
      const messageChatIds = new Set(messageResults.map((msg) => msg.chat_id));

      // Combine and deduplicate results
      const combinedResults: Array<{
        id: string;
        chat_id: string;
        content: string;
        created_at: number;
        updated_at: number;
        chat_title: string;
        match_type: "message" | "title" | "both";
        relevance_score: number;
      }> = [];

      // Add message results
      for (const msg of messageResults) {
        const chat = await ctx.db
          .query("chats")
          .withIndex("by_chat_id", (q) => q.eq("id", msg.chat_id))
          .first();

        combinedResults.push({
          id: msg.id,
          chat_id: msg.chat_id,
          content: msg.content || "",
          created_at: msg._creationTime,
          updated_at: chat?.update_time || msg.update_time,
          chat_title: chat?.title || "",
          match_type: "message",
          relevance_score: 2, // Message content matches get high score
        });
      }

      // Add chat title results (only if not already added via message)
      for (const chat of chatResults) {
        const hasMessageMatch = messageChatIds.has(chat.id);

        if (hasMessageMatch) {
          // Update existing result to "both"
          const existingResult = combinedResults.find(
            (r) => r.chat_id === chat.id,
          );
          if (existingResult) {
            existingResult.match_type = "both";
            existingResult.relevance_score = 3; // Both matches get highest score
            existingResult.updated_at = chat.update_time; // Use chat's update time
          }
        } else {
          // Get the most recent message for content preview
          const recentMessage = await ctx.db
            .query("messages")
            .withIndex("by_chat_id", (q) => q.eq("chat_id", chat.id))
            .order("desc")
            .first();

          combinedResults.push({
            id: `title-${chat.id}`,
            chat_id: chat.id,
            content: recentMessage?.content || "",
            created_at: recentMessage?._creationTime || chat._creationTime,
            updated_at: chat.update_time,
            chat_title: chat.title,
            match_type: "title",
            relevance_score: 1, // Title-only matches get lower score
          });
        }
      }

      // Sort by relevance score (highest first), then by recency
      combinedResults.sort((a, b) => {
        if (a.relevance_score !== b.relevance_score) {
          return b.relevance_score - a.relevance_score;
        }
        return b.updated_at - a.updated_at;
      });

      // Apply pagination manually
      const parsedOffset = args.paginationOpts.cursor
        ? parseInt(args.paginationOpts.cursor, 10) || 0
        : 0;
      const startIndex = parsedOffset;
      const numItems = args.paginationOpts.numItems;
      const paginatedResults = combinedResults.slice(
        startIndex,
        startIndex + numItems,
      );

      const hasMoreItems = startIndex + numItems < combinedResults.length;
      const nextOffset = hasMoreItems ? startIndex + numItems : 0;

      return {
        page: paginatedResults.map((result) => ({
          id: result.id,
          chat_id: result.chat_id,
          content: result.content,
          created_at: result.created_at,
          updated_at: result.updated_at,
          chat_title: result.chat_title,
          match_type: result.match_type,
        })),
        isDone: startIndex + numItems >= combinedResults.length,
        continueCursor: hasMoreItems ? nextOffset.toString() : "",
      };
    } catch (error) {
      console.error("Failed to search messages:", error);
      return {
        page: [],
        isDone: true,
        continueCursor: "",
      };
    }
  },
});

/**
 * Branch chat from a specific message - creates a new chat with messages up to and including the specified message
 */
export const branchChat = mutation({
  args: {
    messageId: v.string(),
  },
  returns: v.string(),
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
      }

      if (message.user_id !== user.subject) {
        throw new Error("Unauthorized: Message does not belong to user");
      }

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

      // Get original chat to copy title
      const originalChat = await ctx.db
        .query("chats")
        .withIndex("by_chat_id", (q) => q.eq("id", message.chat_id))
        .first();

      if (!originalChat) {
        throw new Error("Original chat not found");
      }

      // Get all messages up to and including this message using index range
      const messagesToCopy = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) =>
          q
            .eq("chat_id", message.chat_id)
            .lte("_creationTime", message._creationTime),
        )
        .order("asc")
        .collect();

      // Create new chat with same title as original
      const newChatId = crypto.randomUUID();

      await ctx.db.insert("chats", {
        id: newChatId,
        title: originalChat.title,
        user_id: user.subject,
        branched_from_chat_id: message.chat_id,
        update_time: Date.now(),
      });

      // Copy messages to new chat
      for (const msg of messagesToCopy) {
        const newMessageId = crypto.randomUUID();
        await ctx.db.insert("messages", {
          id: newMessageId,
          chat_id: newChatId,
          user_id: user.subject,
          role: msg.role,
          parts: msg.parts,
          content: msg.content,
          file_ids: msg.file_ids,
          source_message_id: msg.id,
          update_time: Date.now(),
          model: msg.model,
          generation_time_ms: msg.generation_time_ms,
          finish_reason: msg.finish_reason,
          usage: msg.usage,
        });
      }

      return newChatId;
    } catch (error) {
      console.error("Failed to branch chat:", error);
      throw error;
    }
  },
});

/**
 * Regenerate with new content by updating a message and deleting subsequent messages
 * Optionally keep specified files (pass fileIds to keep, undefined to remove all)
 */
export const regenerateWithNewContent = mutation({
  args: {
    messageId: v.string(),
    newContent: v.string(),
    fileIds: v.optional(v.array(v.string())),
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
        // Silently no-op if the message no longer exists (edited/removed locally or race)
        // Avoid throwing/logging to prevent noisy errors on client
        return null;
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

      // Determine which files to keep
      const currentFileIds = message.file_ids || [];
      let newFileIds: Id<"files">[] | undefined = undefined;
      let filesToDelete: Id<"files">[] = [];

      if (args.fileIds !== undefined) {
        // Keep only the specified files
        const keepSet = new Set(args.fileIds);
        newFileIds = currentFileIds.filter((id) => keepSet.has(id as string));
        filesToDelete = currentFileIds.filter(
          (id) => !keepSet.has(id as string),
        );
      } else {
        // Remove all files (existing behavior)
        filesToDelete = currentFileIds;
      }

      // Delete removed files
      for (const fileId of filesToDelete) {
        try {
          const file = await ctx.db.get(fileId);
          if (file) {
            // Delete from appropriate storage
            if (file.s3_key) {
              await ctx.scheduler.runAfter(
                0,
                internal.s3Cleanup.deleteS3ObjectAction,
                { s3Key: file.s3_key },
              );
            } else if (file.storage_id) {
              await ctx.storage.delete(file.storage_id);
            }
            // Delete from aggregate
            await fileCountAggregate.deleteIfExists(ctx, file);
            await ctx.db.delete(file._id);
          }
        } catch (error) {
          console.error(`Failed to delete file ${fileId}:`, error);
        }
      }

      // Build new parts: text + remaining file parts
      const newParts: any[] = [];
      if (args.newContent.trim()) {
        newParts.push({ type: "text", text: args.newContent });
      }

      // Keep file parts for remaining files
      if (newFileIds && newFileIds.length > 0) {
        const existingFileParts = message.parts.filter(
          (part: any) =>
            part.type === "file" &&
            part.fileId &&
            newFileIds!.some((id) => id === part.fileId),
        );
        newParts.push(...existingFileParts);
      }

      await ctx.db.patch(message._id, {
        parts:
          newParts.length > 0
            ? newParts
            : [{ type: "text", text: args.newContent }],
        content: args.newContent.trim() || undefined,
        file_ids: newFileIds && newFileIds.length > 0 ? newFileIds : undefined,
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

      // Check summary invalidation before deleting messages
      await checkAndInvalidateSummary(ctx, message.chat_id, [
        { id: message.id, creationTime: message._creationTime },
        ...messages.map((m) => ({ id: m.id, creationTime: m._creationTime })),
      ]);

      for (const msg of messages) {
        if (msg.file_ids && msg.file_ids.length > 0) {
          for (const fileId of msg.file_ids) {
            try {
              const file = await ctx.db.get(fileId);
              if (file) {
                // Delete from appropriate storage
                if (file.s3_key) {
                  await ctx.scheduler.runAfter(
                    0,
                    internal.s3Cleanup.deleteS3ObjectAction,
                    { s3Key: file.s3_key },
                  );
                } else if (file.storage_id) {
                  await ctx.storage.delete(file.storage_id);
                }
                // Delete from aggregate
                await fileCountAggregate.deleteIfExists(ctx, file);
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
      // Only log unexpected errors. "Message not found" is treated as a benign no-op above.
      if (
        !(
          error instanceof Error &&
          (error.message.includes("Message not found") ||
            error.message.includes("CHAT_NOT_FOUND") ||
            error.message.includes("CHAT_UNAUTHORIZED"))
        )
      ) {
        console.error("Failed to regenerate with new content:", error);
      }
      // Do not surface benign errors to the client
      if (
        error instanceof Error &&
        error.message.includes("Message not found")
      ) {
        return null;
      }
      throw error;
    }
  },
});

/**
 * Get messages for a shared chat (PUBLIC - no auth required).
 *
 * SECURITY FEATURES:
 * 1. No authentication required - anyone with share link can access
 * 2. Only returns messages for chats that are shared (have share_id)
 * 3. FROZEN CONTENT: Only returns messages up to share_date
 * 4. Strips user_id from response (anonymity)
 * 5. Replaces file/image parts with placeholders (no file URLs exposed)
 *
 * This implements the "frozen share" concept: when a chat is shared,
 * the shared link only shows messages that existed at share time.
 * New messages added after sharing are NOT visible until user updates the share.
 *
 * @param chatId - The ID of the chat to get messages for
 * @returns Array of messages (up to share_date) with files/images as placeholders
 */
export const getSharedMessages = query({
  args: { chatId: v.string() },
  returns: v.array(
    v.object({
      id: v.string(),
      role: v.union(
        v.literal("user"),
        v.literal("assistant"),
        v.literal("system"),
      ),
      parts: v.array(v.any()),
      content: v.optional(v.string()),
      update_time: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    try {
      // Validate UUID format
      const UUID_REGEX =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_REGEX.test(args.chatId)) {
        return [];
      }

      // CRITICAL SECURITY CHECK: Verify the chat is actually shared
      const chat = await ctx.db
        .query("chats")
        .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
        .first();

      // Return empty array if chat doesn't exist or isn't shared
      if (!chat || !chat.share_id || !chat.share_date) {
        return [];
      }

      // Get all messages for this chat
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
        .order("asc")
        .collect();

      // FROZEN CONTENT: Filter messages to only those created/updated before share_date
      // This ensures new messages added after sharing are not visible
      const frozenMessages = messages.filter(
        (msg) => msg.update_time <= chat.share_date!,
      );

      // Strip sensitive data and replace files with placeholders
      return frozenMessages.map((msg) => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        update_time: msg.update_time,
        // Process parts to replace files/images with placeholders
        parts: msg.parts.map((part: any) => {
          // Replace file references with placeholder
          if (part.type === "file") {
            // Determine if it's an image based on mediaType
            const isImage = part.mediaType?.startsWith("image/");
            return {
              type: isImage ? "image" : "file",
              placeholder: true,
              // SECURITY: Do NOT include url, storage_id, file_id, name, or mediaType
            };
          }
          // Keep text parts as-is
          return part;
        }),
        // SECURITY: user_id is NOT included in response (anonymity)
      }));
    } catch (error) {
      console.error("Failed to get shared messages:", error);
      // Return empty array on error (fail secure)
      return [];
    }
  },
});

/**
 * Get first two messages (user and assistant) for share preview
 * Used to show a preview in the share dialog
 */
export const getPreviewMessages = query({
  args: { chatId: v.string() },
  returns: v.array(
    v.object({
      id: v.string(),
      role: v.union(
        v.literal("user"),
        v.literal("assistant"),
        v.literal("system"),
      ),
      content: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    try {
      const chat = await ctx.db
        .query("chats")
        .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
        .first();

      if (!chat || chat.user_id !== identity.subject) {
        return [];
      }

      const messages = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
        .order("asc")
        .take(10);

      // Get first 4 messages (user and assistant messages only)
      const result = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(0, 4)
        .map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
        }));

      return result;
    } catch (error) {
      console.error("Failed to get preview messages:", error);
      return [];
    }
  },
});
