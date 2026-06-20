import { query, mutation, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import { fileCountAggregate } from "./fileAggregate";
import { MAX_PREVIOUS_SUMMARIES } from "./constants";
import { validateServiceKey } from "./lib/utils";
import {
  coerceSelectedModel,
  normalizeSelectedModelForSubscription,
} from "../types/chat";
import {
  parseEntitlements,
  resolveSubscriptionTier,
} from "../lib/auth/entitlements";
import { convexLogger } from "./lib/logger";

const DELETE_ALL_CHATS_MESSAGE_BATCH_SIZE = 10;
const DELETE_ALL_CHATS_SUMMARY_BATCH_SIZE = 25;

async function getMessageCreationTimeById(
  ctx: MutationCtx,
  messageId: string,
): Promise<number | null> {
  const message = await ctx.db
    .query("messages")
    .withIndex("by_message_id", (q) => q.eq("id", messageId))
    .first();

  return message?._creationTime ?? null;
}

async function scheduleDeleteAllChatsBatch(ctx: MutationCtx, userId: string) {
  await ctx.scheduler.runAfter(0, internal.chats.deleteAllChatsBatch, {
    userId,
  });
}

async function publishDeletionCancellation(ctx: MutationCtx, chatId: string) {
  try {
    await ctx.scheduler.runAfter(0, internal.redisPubsub.publishCancellation, {
      chatId,
      skipSave: true,
    });
  } catch (error) {
    console.error(
      `Failed to publish cancellation for deleted chat ${chatId}:`,
      error,
    );
  }
}

async function deleteChatDocument(ctx: MutationCtx, chat: Doc<"chats">) {
  // Publish even when active_stream_id is not set yet; fast deletes can race
  // stream registration, and a no-listener cancellation message is harmless.
  await publishDeletionCancellation(ctx, chat.id);

  // Delete all messages and their associated files
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", chat.id))
    .collect();

  for (const message of messages) {
    // Skip deleting files for copied messages (they reference original chat files)
    if (!message.source_message_id) {
      // Clean up files associated with this message
      if (message.file_ids && message.file_ids.length > 0) {
        for (const fileId of message.file_ids) {
          try {
            const file = await ctx.db.get(fileId);
            if (file) {
              if (file.s3_key) {
                await ctx.scheduler.runAfter(
                  0,
                  internal.s3Cleanup.deleteS3ObjectAction,
                  { s3Key: file.s3_key },
                );
              }
              // Delete from aggregate
              await fileCountAggregate.deleteIfExists(ctx, file);
              await ctx.db.delete(file._id);
            }
          } catch (error) {
            console.error(`Failed to delete file ${fileId}:`, error);
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

async function deleteNextUserChatBatch(ctx: MutationCtx, userId: string) {
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_user_and_updated", (q) => q.eq("user_id", userId))
    .first();

  if (!chat) {
    return false;
  }

  const messages = await ctx.db
    .query("messages")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", chat.id))
    .take(DELETE_ALL_CHATS_MESSAGE_BATCH_SIZE);

  if (messages.length > 0) {
    for (const message of messages) {
      if (!message.source_message_id && message.file_ids?.length) {
        for (const fileId of message.file_ids) {
          try {
            const file = await ctx.db.get(fileId);
            if (file) {
              if (file.s3_key) {
                await ctx.scheduler.runAfter(
                  0,
                  internal.s3Cleanup.deleteS3ObjectAction,
                  { s3Key: file.s3_key },
                );
              }
              await fileCountAggregate.deleteIfExists(ctx, file);
              await ctx.db.delete(file._id);
            }
          } catch (error) {
            console.error(`Failed to delete file ${fileId}:`, error);
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

    await scheduleDeleteAllChatsBatch(ctx, userId);
    return true;
  }

  const summaries = await ctx.db
    .query("chat_summaries")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", chat.id))
    .take(DELETE_ALL_CHATS_SUMMARY_BATCH_SIZE);

  if (summaries.length > 0) {
    for (const summary of summaries) {
      try {
        await ctx.db.delete(summary._id);
      } catch (error) {
        console.error(`Failed to delete summary ${summary._id}:`, error);
      }
    }

    await scheduleDeleteAllChatsBatch(ctx, userId);
    return true;
  }

  await ctx.db.delete(chat._id);
  await scheduleDeleteAllChatsBatch(ctx, userId);
  return true;
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
      sandbox_type: v.optional(v.string()),
      selected_model: v.optional(v.string()),
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

      // Drop legacy codex_thread_id from the response — preserved on the row
      // for old data but not exposed to clients.
      const { codex_thread_id: _legacy, ...chatPublic } = chat;

      // Fetch branched_from_title if this chat is branched from another chat
      if (chatPublic.branched_from_chat_id) {
        const branchedFromChat = await ctx.db
          .query("chats")
          .withIndex("by_chat_id", (q) =>
            q.eq("id", chatPublic.branched_from_chat_id!),
          )
          .first();

        return {
          ...chatPublic,
          branched_from_title: branchedFromChat?.title,
        };
      }

      return chatPublic;
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
      sandbox_type: v.optional(v.string()),
      selected_model: v.optional(v.string()),
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

      if (!chat) return null;

      // Drop legacy codex_thread_id from the response — preserved on the row
      // for old data but not exposed to callers.
      const { codex_thread_id: _legacy, ...chatPublic } = chat;
      return chatPublic;
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
 * Persist per-chat picker preferences (selected model + mode) when the user
 * toggles them in the UI, before sending. Client-callable, ownership-checked.
 *
 * Intentionally does NOT bump `update_time` (would reorder the sidebar) or
 * touch stream state — those side effects belong to `updateChat`, which only
 * the backend should call at end-of-stream.
 */
export const updateChatPreferences = mutation({
  args: {
    id: v.string(),
    selectedModel: v.optional(v.string()),
    mode: v.optional(
      v.union(v.literal("ask"), v.literal("agent"), v.literal("agent-long")),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Not authenticated",
      });
    }

    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.id))
      .first();

    // No-op for chats that haven't been created server-side yet — the backend
    // will write these fields on first send via `updateChat`.
    if (!chat) return null;

    if (chat.user_id !== user.subject) {
      throw new ConvexError({ code: "FORBIDDEN", message: "Not your chat" });
    }

    const patch: Record<string, unknown> = {};
    if (args.selectedModel !== undefined) {
      // Coerce legacy / unknown ids before writing so the row never ends up
      // with a value the load path will silently rewrite later. Unknown ids
      // are dropped (skipped) rather than written verbatim.
      const coerced = coerceSelectedModel(args.selectedModel);
      const subscription = resolveSubscriptionTier(
        parseEntitlements(user.entitlements),
      );
      if (coerced !== null || subscription === "free") {
        patch.selected_model = normalizeSelectedModelForSubscription(
          coerced,
          subscription,
        );
      }
    }
    if (args.mode !== undefined) {
      patch.default_model_slug = args.mode;
    }
    if (Object.keys(patch).length === 0) return null;

    await ctx.db.patch(chat._id, patch);
    return null;
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
    sandboxType: v.optional(v.string()),
    selectedModel: v.optional(v.string()),
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
        // Benign race: chat was deleted before this server-internal update
        // arrived (e.g., user deleted mid-stream). Nothing to update.
        return null;
      }

      // Prepare update object with only provided fields.
      // update_time is only bumped for user-visible changes (title, model,
      // sandbox) so that background writes (todos, stream-state cleanup,
      // finish_reason) don't invalidate the sidebar's by_user_and_updated
      // query on every agent turn.
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
        sandbox_type?: string;
        selected_model?: string;
        active_stream_id?: undefined;
        canceled_at?: undefined;
        update_time?: number;
      } = {
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

      if (args.sandboxType !== undefined) {
        updateData.sandbox_type = args.sandboxType;
      }

      if (args.selectedModel !== undefined) {
        updateData.selected_model = args.selectedModel;
      }

      // Bump update_time only when a sidebar-visible field actually changed.
      if (
        args.title !== undefined ||
        args.defaultModelSlug !== undefined ||
        args.sandboxType !== undefined ||
        args.selectedModel !== undefined
      ) {
        updateData.update_time = Date.now();
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
 * Get user's latest chats with pagination. Pinned chats appear first in pin order.
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
      const MAX_PINNED_CHATS = 100;

      const isFirstPage =
        args.paginationOpts.cursor == null || args.paginationOpts.cursor === "";

      // Step 1: Fetch pinned chats only for the first page. Later pages can
      // filter pinned rows directly from their own page payload, which avoids
      // rereading every pinned chat on each pagination request.
      const pinnedChats = isFirstPage
        ? await ctx.db
            .query("chats")
            .withIndex("by_user_and_pinned", (q) =>
              q.eq("user_id", identity.subject).gt("pinned_at", 0),
            )
            .order("asc")
            .take(MAX_PINNED_CHATS)
        : [];

      if (isFirstPage && pinnedChats.length === MAX_PINNED_CHATS) {
        convexLogger.warn("chat_sidebar_pinned_cap_reached", {
          user_id: identity.subject,
          pinned_cap: MAX_PINNED_CHATS,
          requested_page_size: args.paginationOpts.numItems,
          has_cursor: false,
        });
      }

      // Step 2: Fetch one page (no over-fetch: slicing would lose items permanently
      // because the cursor advances past all fetched items)
      const result = await ctx.db
        .query("chats")
        .withIndex("by_user_and_updated", (q) =>
          q.eq("user_id", identity.subject),
        )
        .order("desc")
        .paginate(args.paginationOpts);

      const unpinnedPage = result.page.filter((c) => c.pinned_at == null);
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
      convexLogger.error("chat_sidebar_query_failed", {
        user_id: identity.subject,
        requested_page_size: args.paginationOpts.numItems,
        has_cursor: Boolean(args.paginationOpts.cursor),
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : String(error),
      });
      return {
        page: [],
        isDone: true,
        continueCursor: "",
      };
    }
  },
});

/**
 * Pin a chat. Pinned chats appear at the top of the list.
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

      await deleteChatDocument(ctx, chat);

      return null;
    } catch (error) {
      console.error("Failed to delete chat:", error);
      // Avoid surfacing errors to the client; treat as a no-op
      return null;
    }
  },
});

/**
 * Delete a chat from a trusted server route after ownership is verified.
 */
export const deleteChatForBackend = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
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

    if (chat.user_id !== args.userId) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "Unauthorized: Chat does not belong to user",
      });
    }

    await deleteChatDocument(ctx, chat);
    return null;
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
  handler: async (ctx) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    try {
      await deleteNextUserChatBatch(ctx, user.subject);

      return null;
    } catch (error) {
      console.error("Failed to delete all chats:", error);
      throw error;
    }
  },
});

export const deleteAllChatsBatch = internalMutation({
  args: {
    userId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      await deleteNextUserChatBatch(ctx, args.userId);
      return null;
    } catch (error) {
      console.error("Failed to delete all chats batch:", error);
      throw error;
    }
  },
});

/**
 * Set the active trigger.dev run id for a chat (used by /api/agent-long when
 * kicking off a long-running task). Stored on the chat row so the cancel
 * endpoint and reconnect flow can find the in-flight run by chatId.
 */
export const setActiveTriggerRun = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    triggerRunId: v.union(v.string(), v.null()),
    expectedRunId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();
    if (!chat) return null;
    if (
      args.expectedRunId !== undefined &&
      chat.active_trigger_run_id !== args.expectedRunId
    ) {
      return null;
    }
    await ctx.db.patch(chat._id, {
      active_trigger_run_id: args.triggerRunId ?? undefined,
    });
    return null;
  },
});

/**
 * Get the active trigger.dev run id for a chat. Used by the cancel endpoint
 * (client doesn't know the runId; only the server-stored row does).
 */
export const getActiveTriggerRun = query({
  args: { serviceKey: v.string(), chatId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();
    return chat?.active_trigger_run_id ?? null;
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
          for (const fileId of message.file_ids) {
            try {
              const file = await ctx.db.get(fileId);
              if (file) {
                if (file.s3_key) {
                  await ctx.scheduler.runAfter(
                    0,
                    internal.s3Cleanup.deleteS3ObjectAction,
                    { s3Key: file.s3_key },
                  );
                }
                await fileCountAggregate.deleteIfExists(ctx, file);
                await ctx.db.delete(file._id);
              }
            } catch (error) {
              console.error(`Failed to delete file ${fileId}:`, error);
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
    metadata: v.optional(
      v.object({
        reason: v.optional(
          v.union(
            v.literal("token_threshold"),
            v.literal("provider_input_threshold"),
            v.literal("provider_pressure"),
          ),
        ),
        promptVersion: v.optional(v.string()),
        model: v.optional(v.string()),
        status: v.optional(v.string()),
        error: v.optional(v.string()),
        inputTokens: v.optional(v.number()),
        outputTokens: v.optional(v.number()),
        cacheReadTokens: v.optional(v.number()),
        cacheWriteTokens: v.optional(v.number()),
        cost: v.optional(v.number()),
        estimatedCompactedInputTokens: v.optional(v.number()),
        transcriptPath: v.optional(v.string()),
      }),
    ),
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
        // Benign race: chat was deleted before the summary write landed.
        return null;
      }

      const incomingCutoffCreationTime = await getMessageCreationTimeById(
        ctx,
        args.summaryUpToMessageId,
      );

      if (incomingCutoffCreationTime === null) {
        convexLogger.warn("chat_summary_cutoff_missing", {
          service: "convex",
          environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
          chat_id: args.chatId,
          summary_up_to_message_id: args.summaryUpToMessageId,
        });
        return null;
      }

      // Log sizes to help diagnose document limit issues
      const summaryTextSizeKB = Math.round(
        new TextEncoder().encode(args.summaryText).length / 1024,
      );
      convexLogger.info("chat_summary_save_started", {
        service: "convex",
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
        chat_id: args.chatId,
        summary_up_to_message_id: args.summaryUpToMessageId,
        summary_up_to_message_creation_time: incomingCutoffCreationTime,
        summary_text_size_kb: summaryTextSizeKB,
        has_previous_summary: !!chat.latest_summary_id,
        previous_summary_id: chat.latest_summary_id,
      });

      let previousSummaries: {
        summary_text: string;
        summary_up_to_message_id: string;
        summary_up_to_message_creation_time?: number;
      }[] = [];

      if (chat.latest_summary_id) {
        const oldSummary = await ctx.db.get(chat.latest_summary_id);
        if (oldSummary) {
          const oldSummaryWithCreationTime = oldSummary as typeof oldSummary & {
            summary_up_to_message_creation_time?: number;
          };
          const previousSummaryCutoffCreationTime =
            oldSummaryWithCreationTime.summary_up_to_message_creation_time ??
            (await getMessageCreationTimeById(
              ctx,
              oldSummary.summary_up_to_message_id,
            ));

          const isStaleSummary =
            previousSummaryCutoffCreationTime !== null &&
            (incomingCutoffCreationTime < previousSummaryCutoffCreationTime ||
              (incomingCutoffCreationTime ===
                previousSummaryCutoffCreationTime &&
                args.summaryUpToMessageId ===
                  oldSummary.summary_up_to_message_id));

          if (isStaleSummary) {
            convexLogger.info("chat_summary_stale_save_skipped", {
              service: "convex",
              environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
              chat_id: args.chatId,
              incoming_summary_up_to_message_id: args.summaryUpToMessageId,
              incoming_summary_up_to_message_creation_time:
                incomingCutoffCreationTime,
              current_summary_id: chat.latest_summary_id,
              current_summary_up_to_message_id:
                oldSummary.summary_up_to_message_id,
              current_summary_up_to_message_creation_time:
                previousSummaryCutoffCreationTime,
            });
            return null;
          }

          previousSummaries = [
            {
              summary_text: oldSummary.summary_text,
              summary_up_to_message_id: oldSummary.summary_up_to_message_id,
              ...(previousSummaryCutoffCreationTime !== null
                ? {
                    summary_up_to_message_creation_time:
                      previousSummaryCutoffCreationTime,
                  }
                : undefined),
            },
            ...(oldSummary.previous_summaries ?? []),
          ].slice(0, MAX_PREVIOUS_SUMMARIES);
        } else {
          convexLogger.warn("chat_summary_latest_missing", {
            service: "convex",
            environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
            chat_id: args.chatId,
            latest_summary_id: chat.latest_summary_id,
          });
        }
      }

      // Log total document size before insert
      const previousSummariesTotalSizeKB = Math.round(
        previousSummaries.reduce(
          (acc, s) => acc + new TextEncoder().encode(s.summary_text).length,
          0,
        ) / 1024,
      );
      convexLogger.info("chat_summary_document_sized", {
        service: "convex",
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
        chat_id: args.chatId,
        summary_up_to_message_id: args.summaryUpToMessageId,
        summary_text_size_kb: summaryTextSizeKB,
        previous_summaries_count: previousSummaries.length,
        previous_summaries_total_size_kb: previousSummariesTotalSizeKB,
        estimated_total_size_kb:
          summaryTextSizeKB + previousSummariesTotalSizeKB,
      });

      const summaryMetadata = Object.fromEntries(
        Object.entries({
          reason: args.metadata?.reason,
          prompt_version: args.metadata?.promptVersion,
          model: args.metadata?.model,
          status: args.metadata?.status ?? "completed",
          error: args.metadata?.error,
          input_tokens: args.metadata?.inputTokens,
          output_tokens: args.metadata?.outputTokens,
          cache_read_tokens: args.metadata?.cacheReadTokens,
          cache_write_tokens: args.metadata?.cacheWriteTokens,
          cost: args.metadata?.cost,
          estimated_compacted_input_tokens:
            args.metadata?.estimatedCompactedInputTokens,
          transcript_path: args.metadata?.transcriptPath,
        }).filter(([, value]) => value !== undefined),
      );

      const summaryId = await ctx.db.insert("chat_summaries", {
        chat_id: args.chatId,
        summary_text: args.summaryText,
        summary_up_to_message_id: args.summaryUpToMessageId,
        summary_up_to_message_creation_time: incomingCutoffCreationTime,
        ...summaryMetadata,
        previous_summaries: previousSummaries,
      });

      // Update chat to reference the latest summary (fast ID lookup).
      // Not a sidebar-visible change, so don't bump update_time.
      await ctx.db.patch(chat._id, {
        latest_summary_id: summaryId,
      });

      convexLogger.info("chat_summary_saved", {
        service: "convex",
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
        chat_id: args.chatId,
        summary_id: summaryId,
        summary_up_to_message_id: args.summaryUpToMessageId,
        summary_up_to_message_creation_time: incomingCutoffCreationTime,
        previous_summary_id: chat.latest_summary_id,
        previous_summaries_count: previousSummaries.length,
      });

      return null;
    } catch (error) {
      convexLogger.error("chat_summary_save_failed", {
        service: "convex",
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
        chat_id: args.chatId,
        summary_up_to_message_id: args.summaryUpToMessageId,
        summary_text_length: args.summaryText.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
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
