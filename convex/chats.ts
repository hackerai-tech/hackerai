import { query, mutation, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v, ConvexError, type Value } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import { fileCountAggregate } from "./fileAggregate";
import { MAX_PREVIOUS_SUMMARIES } from "./constants";
import { validateServiceKey } from "./lib/utils";
import {
  retainedTailValidator,
  type RetainedTailDoc,
} from "./lib/retainedTail";
import {
  coerceSelectedModel,
  normalizeSelectedModelForSubscription,
} from "../types/chat";
import {
  parseEntitlements,
  resolveSubscriptionTier,
} from "../lib/auth/entitlements";
import { parseSandboxScopedAgentApprovalTargetPrefix } from "../types/agent";
import { convexLogger } from "./lib/logger";
import {
  CHAT_ACCESS_SUSPENDED_CODE,
  assertUserCanAccessChatHistory,
} from "./lib/suspensionGuards";

const DELETE_ALL_CHATS_MESSAGE_BATCH_SIZE = 10;
const DELETE_ALL_CHATS_SUMMARY_BATCH_SIZE = 25;
const CHAT_DELETION_FENCE_BATCH_SIZE = 100;
const MAX_ACTIVE_TRIGGER_RUNS_TO_RETURN = 100;
const CHAT_SUMMARY_TELEMETRY_CLEANUP_DEFAULT_BATCH_SIZE = 500;
const CHAT_SUMMARY_TELEMETRY_CLEANUP_MAX_BATCH_SIZE = 1000;
const CHAT_SUMMARY_TELEMETRY_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cost",
  "estimated_compacted_input_tokens",
] as const;

const activeAgentApprovalRequestValidator = v.object({
  approvalId: v.string(),
  toolCallId: v.string(),
  operation: v.optional(
    v.union(
      v.literal("terminal_execute"),
      v.literal("terminal_interact"),
      v.literal("file_write"),
      v.literal("file_append"),
      v.literal("file_edit"),
    ),
  ),
  target: v.optional(v.string()),
  justification: v.optional(v.string()),
  prefixRule: v.optional(v.array(v.string())),
  title: v.optional(v.string()),
  detail: v.optional(v.string()),
  kind: v.optional(v.union(v.literal("terminal"), v.literal("file"))),
  createdAt: v.optional(v.number()),
});

const agentApprovalTargetGrantValidator = v.union(
  v.object({
    kind: v.literal("terminal_command"),
    targetPrefix: v.string(),
    executable: v.string(),
    argv: v.array(v.string()),
  }),
  v.object({
    kind: v.literal("file_change"),
    targetPrefix: v.string(),
    path: v.string(),
    pathFlavor: v.union(v.literal("posix"), v.literal("windows")),
  }),
);

const activeAgentResourceValidator = v.object({
  chatId: v.string(),
  triggerRunId: v.optional(v.string()),
  approvalSessionId: v.optional(v.string()),
});

const MAX_AGENT_APPROVAL_GRANTS_PER_CHAT = 100;

const getErrorName = (error: unknown): string =>
  error instanceof Error ? error.name : typeof error;

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const getConvexErrorData = (error: unknown): Value | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const data = (error as { data?: unknown }).data;
  return data === undefined ? undefined : (data as Value);
};

const getConvexErrorCode = (data: Value | undefined): string | undefined => {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }

  const code = (data as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
};

function normalizeTelemetryCleanupBatchSize(batchSize?: number): number {
  if (!Number.isFinite(batchSize) || !batchSize) {
    return CHAT_SUMMARY_TELEMETRY_CLEANUP_DEFAULT_BATCH_SIZE;
  }
  return Math.min(
    CHAT_SUMMARY_TELEMETRY_CLEANUP_MAX_BATCH_SIZE,
    Math.max(1, Math.floor(batchSize)),
  );
}

function hasChatSummaryTelemetry(
  summary: Partial<
    Record<(typeof CHAT_SUMMARY_TELEMETRY_FIELDS)[number], unknown>
  >,
): boolean {
  return CHAT_SUMMARY_TELEMETRY_FIELDS.some(
    (field) => summary[field] !== undefined,
  );
}

const CHAT_SUMMARY_TELEMETRY_CLEAR_PATCH = {
  input_tokens: undefined,
  output_tokens: undefined,
  cache_read_tokens: undefined,
  cache_write_tokens: undefined,
  cost: undefined,
  estimated_compacted_input_tokens: undefined,
};

const emptyChatsPage = () => ({
  page: [],
  isDone: true,
  continueCursor: "",
});

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

async function scheduleDeleteChatDocumentBatch(
  ctx: MutationCtx,
  chatId: string,
  userId: string,
) {
  await ctx.scheduler.runAfter(0, internal.chats.deleteChatForBackendBatch, {
    chatId,
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

async function prepareChatForDeletion(ctx: MutationCtx, chat: Doc<"chats">) {
  if (
    chat.active_stream_id === undefined &&
    chat.active_trigger_run_id === undefined &&
    chat.active_agent_approval_pending === undefined &&
    chat.active_agent_approval_request === undefined &&
    chat.canceled_at !== undefined
  ) {
    return;
  }

  // Publish even when active_stream_id is not set yet; fast deletes can race
  // stream registration, and a no-listener cancellation message is harmless.
  await publishDeletionCancellation(ctx, chat.id);

  await ctx.db.patch(chat._id, {
    active_stream_id: undefined,
    active_trigger_run_id: undefined,
    active_agent_approval_session_id: undefined,
    active_agent_approval_pending: undefined,
    active_agent_approval_request: undefined,
    canceled_at: Date.now(),
    deletion_started_at: chat.deletion_started_at ?? Date.now(),
    finish_reason: undefined,
  });
}

async function deleteMessageForChatDeletion(
  ctx: MutationCtx,
  message: Doc<"messages">,
) {
  // Skip deleting files for copied messages (they reference original chat files)
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
      console.error(`Failed to delete feedback ${message.feedback_id}:`, error);
    }
  }

  await ctx.db.delete(message._id);
}

async function deleteChatDocument(ctx: MutationCtx, chat: Doc<"chats">) {
  await prepareChatForDeletion(ctx, chat);

  const messages = await ctx.db
    .query("messages")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", chat.id))
    .take(DELETE_ALL_CHATS_MESSAGE_BATCH_SIZE + 1);

  if (messages.length > 0) {
    for (const message of messages.slice(
      0,
      DELETE_ALL_CHATS_MESSAGE_BATCH_SIZE,
    )) {
      await deleteMessageForChatDeletion(ctx, message);
    }

    if (messages.length > DELETE_ALL_CHATS_MESSAGE_BATCH_SIZE) {
      await scheduleDeleteChatDocumentBatch(ctx, chat.id, chat.user_id);
      return;
    }
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
    await ctx.db.patch(chat._id, { latest_summary_id: undefined });
  }

  // Delete all historical summaries for this chat
  const summaries = await ctx.db
    .query("chat_summaries")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", chat.id))
    .take(DELETE_ALL_CHATS_SUMMARY_BATCH_SIZE + 1);

  for (const summary of summaries.slice(
    0,
    DELETE_ALL_CHATS_SUMMARY_BATCH_SIZE,
  )) {
    try {
      await ctx.db.delete(summary._id);
    } catch (error) {
      console.error(`Failed to delete summary ${summary._id}:`, error);
      // Continue with deletion even if summary cleanup fails
    }
  }

  if (summaries.length > DELETE_ALL_CHATS_SUMMARY_BATCH_SIZE) {
    await scheduleDeleteChatDocumentBatch(ctx, chat.id, chat.user_id);
    return;
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

  await prepareChatForDeletion(ctx, chat);

  const messages = await ctx.db
    .query("messages")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", chat.id))
    .take(DELETE_ALL_CHATS_MESSAGE_BATCH_SIZE);

  if (messages.length > 0) {
    for (const message of messages) {
      await deleteMessageForChatDeletion(ctx, message);
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
      deletion_started_at: v.optional(v.number()),
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
      active_agent_approval_session_id: v.optional(v.string()),
      active_agent_approval_pending: v.optional(v.boolean()),
      active_agent_approval_request: v.optional(
        activeAgentApprovalRequestValidator,
      ),
      sandbox_type: v.optional(v.string()),
      selected_model: v.optional(v.string()),
      project_id: v.optional(v.id("projects")),
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
      await assertUserCanAccessChatHistory(ctx, identity.subject);

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
      const {
        codex_thread_id: _legacy,
        agent_approval_grants: _privateApprovalGrants,
        ...chatPublic
      } = chat;

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
      deletion_started_at: v.optional(v.number()),
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
      active_agent_approval_session_id: v.optional(v.string()),
      active_agent_approval_pending: v.optional(v.boolean()),
      active_agent_approval_request: v.optional(
        activeAgentApprovalRequestValidator,
      ),
      agent_approval_grants: v.optional(
        v.array(agentApprovalTargetGrantValidator),
      ),
      sandbox_type: v.optional(v.string()),
      selected_model: v.optional(v.string()),
      project_id: v.optional(v.id("projects")),
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
    projectId: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    // Verify service role key
    validateServiceKey(args.serviceKey);
    let failureStage = "start";

    try {
      failureStage = "find_existing_chat";
      const existingChat = await ctx.db
        .query("chats")
        .withIndex("by_chat_id", (q) => q.eq("id", args.id))
        .unique();

      if (existingChat) {
        if (existingChat.user_id !== args.userId) {
          throw new ConvexError({
            code: "CHAT_UNAUTHORIZED",
            message: "Chat id belongs to another user",
            operation: "chats.saveChat",
            chatId: args.id,
          });
        }

        return existingChat._id;
      }

      failureStage = "insert_chat";
      let projectId: Id<"projects"> | undefined;
      if (args.projectId) {
        failureStage = "validate_project";
        const normalizedProjectId = ctx.db.normalizeId(
          "projects",
          args.projectId,
        );
        if (!normalizedProjectId) {
          throw new ConvexError({
            code: "PROJECT_NOT_FOUND",
            message: "Project not found",
            operation: "chats.saveChat",
          });
        }
        projectId = normalizedProjectId;
        const project = await ctx.db.get(projectId);
        if (
          !project ||
          project.user_id !== args.userId ||
          project.deletion_started_at !== undefined
        ) {
          throw new ConvexError({
            code: "PROJECT_ACCESS_DENIED",
            message: "Project does not belong to user",
            operation: "chats.saveChat",
          });
        }
      }

      const chatId = await ctx.db.insert("chats", {
        id: args.id,
        title: args.title,
        user_id: args.userId,
        project_id: projectId,
        update_time: Date.now(),
      });

      if (projectId) {
        await ctx.db.patch(projectId, { updated_at: Date.now() });
      }

      return chatId;
    } catch (error) {
      const causeData = getConvexErrorData(error);
      if (
        getConvexErrorCode(causeData) === "CHAT_UNAUTHORIZED" ||
        getConvexErrorCode(causeData) === "PROJECT_NOT_FOUND" ||
        getConvexErrorCode(causeData) === "PROJECT_ACCESS_DENIED"
      ) {
        throw error;
      }

      console.error(
        JSON.stringify({
          level: "error",
          event: "convex_chat_save_failed",
          service: "convex",
          timestamp: new Date().toISOString(),
          db_operation: "chats.saveChat",
          failure_stage: failureStage,
          chat_id: args.id,
          user_id: args.userId,
          title_length: args.title.length,
          error_name: getErrorName(error),
          error_message: getErrorMessage(error),
          convex_error_data: causeData,
        }),
      );
      throw new ConvexError({
        code: "CHAT_SAVE_FAILED",
        message: "Failed to save chat",
        failureStage,
        causeName: getErrorName(error),
        causeMessage: getErrorMessage(error),
        causeData,
        operation: "chats.saveChat",
        chatId: args.id,
        titleLength: args.title.length,
      });
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
      return emptyChatsPage();
    }

    try {
      await assertUserCanAccessChatHistory(ctx, identity.subject);
    } catch (error) {
      if (
        getConvexErrorCode(getConvexErrorData(error)) ===
        CHAT_ACCESS_SUSPENDED_CODE
      ) {
        return emptyChatsPage();
      }

      throw error;
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
        .withIndex("by_user_project_and_updated", (q) =>
          q.eq("user_id", identity.subject).eq("project_id", undefined),
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
      return emptyChatsPage();
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
    await assertUserCanAccessChatHistory(ctx, identity.subject);

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
    await assertUserCanAccessChatHistory(ctx, identity.subject);

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
    await assertUserCanAccessChatHistory(ctx, user.subject);

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
    expectedTriggerRunId: v.union(v.string(), v.null()),
    expectedApprovalSessionId: v.union(v.string(), v.null()),
  },
  returns: v.union(
    v.literal("deleted"),
    v.literal("not_found"),
    v.literal("stale"),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();

    if (!chat) {
      return "not_found" as const;
    }

    if (chat.user_id !== args.userId) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "Unauthorized: Chat does not belong to user",
      });
    }

    if (
      (chat.active_trigger_run_id ?? null) !== args.expectedTriggerRunId ||
      (chat.active_agent_approval_session_id ?? null) !==
        args.expectedApprovalSessionId
    ) {
      return "stale" as const;
    }

    await deleteChatDocument(ctx, chat);
    return "deleted" as const;
  },
});

export const deleteChatForBackendBatch = internalMutation({
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
      return null;
    }

    if (chat.user_id !== args.userId) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "delete_chat_batch_user_mismatch",
          service: "convex",
          timestamp: new Date().toISOString(),
          db_operation: "chats.deleteChatForBackendBatch",
          chat_id: args.chatId,
          expected_user_id: args.userId,
          actual_user_id: chat.user_id,
        }),
      );
      return null;
    }

    await deleteChatDocument(ctx, chat);
    return null;
  },
});

/**
 * Move a chat into a project.
 */
export const moveChatToProject = mutation({
  args: {
    chatId: v.string(),
    projectId: v.id("projects"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }
    await assertUserCanAccessChatHistory(ctx, user.subject);

    const [chat, project] = await Promise.all([
      ctx.db
        .query("chats")
        .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
        .first(),
      ctx.db.get(args.projectId),
    ]);

    if (!chat) {
      throw new ConvexError({
        code: "CHAT_NOT_FOUND",
        message: "Chat not found",
      });
    }
    if (chat.user_id !== user.subject) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "Unauthorized: Chat does not belong to user",
      });
    }
    if (
      !project ||
      project.user_id !== user.subject ||
      project.deletion_started_at !== undefined
    ) {
      throw new ConvexError({
        code: "PROJECT_ACCESS_DENIED",
        message: "Project does not belong to user",
      });
    }
    if (chat.project_id === args.projectId) return false;

    const now = Date.now();
    await Promise.all([
      ctx.db.patch(chat._id, {
        project_id: args.projectId,
        update_time: now,
      }),
      ctx.db.patch(args.projectId, { updated_at: now }),
    ]);
    return true;
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
    await assertUserCanAccessChatHistory(ctx, user.subject);

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
    await assertUserCanAccessChatHistory(ctx, user.subject);

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
 * Fence existing chats in bounded batches before their active agent resources
 * are enumerated. The dedicated marker cannot be cleared by normal stream
 * cleanup, so late run associations remain blocked throughout deletion.
 */
export const fenceChatsForDeletion = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    fencedChats: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
    resources: v.array(activeAgentResourceValidator),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const page = await ctx.db
      .query("chats")
      .withIndex("by_user_and_updated", (q) => q.eq("user_id", args.userId))
      .paginate({
        cursor: args.cursor,
        numItems: CHAT_DELETION_FENCE_BATCH_SIZE,
      });
    const now = Date.now();
    let fencedChats = 0;

    for (const chat of page.page) {
      if (chat.deletion_started_at === undefined) {
        await ctx.db.patch(chat._id, { deletion_started_at: now });
        fencedChats++;
      }
    }

    return {
      fencedChats,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      resources: page.page.flatMap((chat) =>
        chat.active_trigger_run_id || chat.active_agent_approval_session_id
          ? [
              {
                chatId: chat.id,
                ...(chat.active_trigger_run_id
                  ? { triggerRunId: chat.active_trigger_run_id }
                  : {}),
                ...(chat.active_agent_approval_session_id
                  ? {
                      approvalSessionId: chat.active_agent_approval_session_id,
                    }
                  : {}),
              },
            ]
          : [],
      ),
    };
  },
});

/**
 * Set the active trigger.dev run id for a chat (used by /api/agent when
 * kicking off a long-running task). Stored on the chat row so the cancel
 * endpoint and reconnect flow can find the in-flight run by chatId.
 */
export const setActiveTriggerRun = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    triggerRunId: v.union(v.string(), v.null()),
    approvalSessionId: v.optional(v.union(v.string(), v.null())),
    expectedRunId: v.optional(v.string()),
    expectedApprovalSessionId: v.optional(v.string()),
    clearApprovalPending: v.optional(v.boolean()),
  },
  returns: v.union(
    v.literal("updated"),
    v.literal("not_found"),
    v.literal("stale"),
    v.literal("deleting"),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();
    if (!chat) return "not_found" as const;
    if (chat.deletion_started_at !== undefined && args.triggerRunId !== null) {
      return "deleting" as const;
    }
    if (
      args.expectedRunId !== undefined &&
      chat.active_trigger_run_id !== args.expectedRunId
    ) {
      return "stale" as const;
    }
    if (
      args.expectedApprovalSessionId !== undefined &&
      chat.active_agent_approval_session_id !== args.expectedApprovalSessionId
    ) {
      return "stale" as const;
    }
    const shouldClearApprovalPending =
      args.clearApprovalPending === true || args.triggerRunId !== null;

    await ctx.db.patch(chat._id, {
      active_trigger_run_id: args.triggerRunId ?? undefined,
      ...(args.triggerRunId !== null ? { canceled_at: undefined } : {}),
      ...(args.approvalSessionId !== undefined
        ? {
            active_agent_approval_session_id:
              args.approvalSessionId ?? undefined,
          }
        : {}),
      ...(shouldClearApprovalPending
        ? {
            active_agent_approval_pending: undefined,
            active_agent_approval_request: undefined,
          }
        : {}),
    });
    return "updated" as const;
  },
});

export const setActiveAgentApprovalPending = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    pending: v.boolean(),
    request: v.optional(activeAgentApprovalRequestValidator),
    expectedRunId: v.optional(v.string()),
    expectedApprovalSessionId: v.optional(v.string()),
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
    if (
      args.expectedApprovalSessionId !== undefined &&
      chat.active_agent_approval_session_id !== args.expectedApprovalSessionId
    ) {
      return null;
    }
    await ctx.db.patch(chat._id, {
      active_agent_approval_pending: args.pending ? true : undefined,
      active_agent_approval_request: args.pending ? args.request : undefined,
    });
    return null;
  },
});

export const persistAgentApprovalGrant = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    grant: agentApprovalTargetGrantValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();
    if (!chat || chat.user_id !== args.userId) return null;

    // Reusable grants must be bound to the actual sandbox that approved them.
    // Legacy unscoped grants remain readable for migration but are not stored
    // or reused by current workers.
    if (!parseSandboxScopedAgentApprovalTargetPrefix(args.grant.targetPrefix)) {
      return null;
    }

    const current = chat.agent_approval_grants ?? [];
    const alreadyStored = current.some(
      (grant) =>
        grant.kind === args.grant.kind &&
        grant.targetPrefix === args.grant.targetPrefix,
    );
    if (alreadyStored) return null;

    await ctx.db.patch(chat._id, {
      agent_approval_grants: [...current, args.grant].slice(
        -MAX_AGENT_APPROVAL_GRANTS_PER_CHAT,
      ),
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

export const getActiveTriggerRunsForUser = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    runs: v.array(
      v.object({
        chatId: v.string(),
        triggerRunId: v.string(),
        approvalSessionId: v.optional(v.string()),
      }),
    ),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const requestedLimit = Math.floor(
      args.limit ?? MAX_ACTIVE_TRIGGER_RUNS_TO_RETURN,
    );
    const limit = Math.min(
      Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 1, 1),
      MAX_ACTIVE_TRIGGER_RUNS_TO_RETURN,
    );

    const chats = await ctx.db
      .query("chats")
      .withIndex("by_user_and_active_trigger_run", (q) =>
        q.eq("user_id", args.userId).gt("active_trigger_run_id", ""),
      )
      .take(limit + 1);

    return {
      runs: chats.slice(0, limit).flatMap((chat) =>
        chat.active_trigger_run_id
          ? [
              {
                chatId: chat.id,
                triggerRunId: chat.active_trigger_run_id,
                ...(chat.active_agent_approval_session_id
                  ? {
                      approvalSessionId: chat.active_agent_approval_session_id,
                    }
                  : {}),
              },
            ]
          : [],
      ),
      hasMore: chats.length > limit,
    };
  },
});

/**
 * Delete all chats for the authenticated backend user using the same bounded
 * batch deleter as the client mutation.
 */
export const deleteAllChatsForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    await deleteNextUserChatBatch(ctx, args.userId);
    return null;
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
        // Accepted for deploy-skew compatibility with older workers, but no
        // longer persisted on chat_summaries.
        inputTokens: v.optional(v.number()),
        outputTokens: v.optional(v.number()),
        cacheReadTokens: v.optional(v.number()),
        cacheWriteTokens: v.optional(v.number()),
        cost: v.optional(v.number()),
        estimatedCompactedInputTokens: v.optional(v.number()),
        transcriptPath: v.optional(v.string()),
        retainedTail: v.optional(retainedTailValidator),
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
        retained_tail?: RetainedTailDoc;
      }[] = [];

      const previousSummaryId = chat.latest_summary_id;
      let shouldDeletePreviousSummary = false;

      if (previousSummaryId) {
        const oldSummary = await ctx.db.get(previousSummaryId);
        if (oldSummary) {
          shouldDeletePreviousSummary = true;
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
              current_summary_id: previousSummaryId,
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
              retained_tail: oldSummary.retained_tail,
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
            latest_summary_id: previousSummaryId,
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
          transcript_path: args.metadata?.transcriptPath,
          retained_tail: args.metadata?.retainedTail,
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

      let deletedPreviousSummary = false;
      if (
        shouldDeletePreviousSummary &&
        previousSummaryId &&
        previousSummaryId !== summaryId
      ) {
        try {
          await ctx.db.delete(previousSummaryId);
          deletedPreviousSummary = true;
        } catch (error) {
          convexLogger.warn("chat_summary_previous_cleanup_failed", {
            service: "convex",
            environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
            chat_id: args.chatId,
            previous_summary_id: previousSummaryId,
            new_summary_id: summaryId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      convexLogger.info("chat_summary_saved", {
        service: "convex",
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
        chat_id: args.chatId,
        summary_id: summaryId,
        summary_up_to_message_id: args.summaryUpToMessageId,
        summary_up_to_message_creation_time: incomingCutoffCreationTime,
        previous_summary_id: previousSummaryId,
        previous_summaries_count: previousSummaries.length,
        deleted_previous_summary: deletedPreviousSummary,
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
 * Batch cleanup for legacy summary telemetry fields.
 *
 * Run repeatedly in production with the returned cursor until isDone is true,
 * then the optional telemetry columns can be removed from the schema in a
 * follow-up deploy.
 */
export const cleanupChatSummaryTelemetry = mutation({
  args: {
    serviceKey: v.string(),
    paginationOpts: paginationOptsValidator,
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    scanned: v.number(),
    matched: v.number(),
    patched: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const result = await ctx.db
      .query("chat_summaries")
      .order("asc")
      .paginate(args.paginationOpts);

    let matched = 0;
    let patched = 0;
    for (const summary of result.page) {
      if (!hasChatSummaryTelemetry(summary)) continue;

      matched++;
      if (args.dryRun === true) continue;

      await ctx.db.patch(summary._id, CHAT_SUMMARY_TELEMETRY_CLEAR_PATCH);
      patched++;
    }

    return {
      scanned: result.page.length,
      matched,
      patched,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/**
 * Starts an async cleanup job for large production datasets.
 *
 * This schedules internal batches so a 250k-row cleanup does not require
 * hundreds of manual cursor calls.
 */
export const startChatSummaryTelemetryCleanup = mutation({
  args: {
    serviceKey: v.string(),
    batchSize: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    scheduled: v.boolean(),
    batchSize: v.number(),
    dryRun: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const batchSize = normalizeTelemetryCleanupBatchSize(args.batchSize);
    const dryRun = args.dryRun === true;
    await ctx.scheduler.runAfter(
      0,
      internal.chats.cleanupChatSummaryTelemetryBatch,
      {
        cursor: null,
        batchSize,
        dryRun,
        scannedSoFar: 0,
        matchedSoFar: 0,
        patchedSoFar: 0,
        batchCount: 0,
        startedAt: Date.now(),
      },
    );

    return { scheduled: true, batchSize, dryRun };
  },
});

export const cleanupChatSummaryTelemetryBatch = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    batchSize: v.number(),
    dryRun: v.optional(v.boolean()),
    scannedSoFar: v.optional(v.number()),
    matchedSoFar: v.optional(v.number()),
    patchedSoFar: v.optional(v.number()),
    batchCount: v.optional(v.number()),
    startedAt: v.optional(v.number()),
  },
  returns: v.object({
    scanned: v.number(),
    matched: v.number(),
    patched: v.number(),
    totalScanned: v.number(),
    totalMatched: v.number(),
    totalPatched: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const batchSize = normalizeTelemetryCleanupBatchSize(args.batchSize);
    const result = await ctx.db
      .query("chat_summaries")
      .order("asc")
      .paginate({ numItems: batchSize, cursor: args.cursor });

    let matched = 0;
    let patched = 0;
    for (const summary of result.page) {
      if (!hasChatSummaryTelemetry(summary)) continue;

      matched++;
      if (args.dryRun === true) continue;

      await ctx.db.patch(summary._id, CHAT_SUMMARY_TELEMETRY_CLEAR_PATCH);
      patched++;
    }

    const totalScanned = (args.scannedSoFar ?? 0) + result.page.length;
    const totalMatched = (args.matchedSoFar ?? 0) + matched;
    const totalPatched = (args.patchedSoFar ?? 0) + patched;
    const batchCount = (args.batchCount ?? 0) + 1;
    const startedAt = args.startedAt ?? Date.now();

    if (result.isDone) {
      convexLogger.info("chat_summary_telemetry_cleanup_completed", {
        service: "convex",
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
        dry_run: args.dryRun === true,
        batch_size: batchSize,
        batch_count: batchCount,
        scanned: totalScanned,
        matched: totalMatched,
        patched: totalPatched,
        duration_ms: Date.now() - startedAt,
      });
    } else {
      if (batchCount % 25 === 0) {
        convexLogger.info("chat_summary_telemetry_cleanup_progress", {
          service: "convex",
          environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
          dry_run: args.dryRun === true,
          batch_size: batchSize,
          batch_count: batchCount,
          scanned: totalScanned,
          matched: totalMatched,
          patched: totalPatched,
        });
      }

      await ctx.scheduler.runAfter(
        0,
        internal.chats.cleanupChatSummaryTelemetryBatch,
        {
          cursor: result.continueCursor,
          batchSize,
          dryRun: args.dryRun === true,
          scannedSoFar: totalScanned,
          matchedSoFar: totalMatched,
          patchedSoFar: totalPatched,
          batchCount,
          startedAt,
        },
      );
    }

    return {
      scanned: result.page.length,
      matched,
      patched,
      totalScanned,
      totalMatched,
      totalPatched,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
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
      retained_tail: v.optional(retainedTailValidator),
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
        retained_tail: summary.retained_tail,
      };
    } catch (error) {
      console.error("Failed to get latest summary:", error);
      return null;
    }
  },
});
