import { query, mutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v, ConvexError, getDocumentSize, type Value } from "convex/values";
import { internal } from "./_generated/api";
import type { DataModel, Doc, Id } from "./_generated/dataModel";
import {
  paginationOptsValidator,
  type GenericDatabaseReader,
} from "convex/server";
import { validateServiceKey, copyChatSummary } from "./lib/utils";
import { fileCountAggregate } from "./fileAggregate";
import { convexLogger } from "./lib/logger";
import type { RetainedTailDoc } from "./lib/retainedTail";
import {
  assertUserCanAccessChatHistory,
  isUserBlockedByActiveFraudDispute,
} from "./lib/suspensionGuards";
import { stripOpenRouterReasoningMetadataFromParts } from "../lib/chat/provider-metadata-sanitizer";
import {
  MAX_MESSAGE_SEARCH_QUERY_LENGTH,
  MIN_MESSAGE_SEARCH_QUERY_LENGTH,
} from "../lib/utils/message-search";

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

const extractFileIdsFromParts = (parts: any[]): Id<"files">[] =>
  parts
    .filter(
      (part) =>
        part &&
        typeof part === "object" &&
        part.type === "file" &&
        typeof part.fileId === "string",
    )
    .map((part) => part.fileId as Id<"files">);

const getOwnedFileIdSet = async (
  ctx: { db: GenericDatabaseReader<DataModel> },
  fileIds: Id<"files">[],
  userId: string,
): Promise<Set<string>> => {
  const uniqueFileIds = Array.from(new Set(fileIds));
  if (uniqueFileIds.length === 0) return new Set();

  const files = await Promise.all(
    uniqueFileIds.map((fileId) =>
      ctx.db.get(fileId).catch((error) => {
        console.warn(
          "Failed to read file while checking ownership:",
          fileId,
          error,
        );
        return null;
      }),
    ),
  );

  return new Set(
    files
      .filter((file) => file && file.user_id === userId)
      .map((file) => file!._id),
  );
};

const stripUnownedFileParts = (
  parts: any[],
  ownedFileIds: Set<string>,
): any[] =>
  parts.filter((part) => {
    if (
      !part ||
      typeof part !== "object" ||
      part.type !== "file" ||
      typeof part.fileId !== "string"
    ) {
      return true;
    }

    return ownedFileIds.has(part.fileId);
  });

const getJsonSize = (value: unknown): number => {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
};

const CONVEX_DOCUMENT_MAX_BYTES = 1024 * 1024;
const MESSAGE_DOCUMENT_TARGET_BYTES = 960 * 1024;
const MIN_SEARCH_CONTENT_CHARS = 256;

const getMessageDocumentSize = (document: Record<string, unknown>): number =>
  getDocumentSize(document as Record<string, Value>);

const sliceValidUnicodePrefix = (value: string, end: number): string => {
  const sliced = value.slice(0, end);
  const lastCodeUnit = sliced.charCodeAt(sliced.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    return sliced.slice(0, -1);
  }
  return sliced;
};

const fitSearchContentToDocument = (
  baseDocument: Record<string, unknown>,
  content: string,
): { content?: string; fullSizeBytes: number; indexedSizeBytes?: number } => {
  const fullDocument = { ...baseDocument, content };
  const fullSizeBytes = getMessageDocumentSize(fullDocument);
  if (fullSizeBytes <= MESSAGE_DOCUMENT_TARGET_BYTES) {
    return { content, fullSizeBytes, indexedSizeBytes: fullSizeBytes };
  }

  let low = 0;
  let high = content.length;
  let best = "";
  let bestSize: number | undefined;

  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = sliceValidUnicodePrefix(content, midpoint);
    const candidateSize = getMessageDocumentSize({
      ...baseDocument,
      content: candidate,
    });

    if (candidateSize <= MESSAGE_DOCUMENT_TARGET_BYTES) {
      best = candidate;
      bestSize = candidateSize;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  if (best.length < MIN_SEARCH_CONTENT_CHARS) {
    return { fullSizeBytes };
  }

  return {
    content: best,
    fullSizeBytes,
    indexedSizeBytes: bestSize,
  };
};

const getMessageSaveDiagnostics = (parts: any[]) => {
  const partTypes: Record<string, number> = {};
  let largestPartType = "unknown";
  let largestPartSize = 0;
  let textChars = 0;
  let reasoningChars = 0;
  let toolPartCount = 0;
  let dataPartCount = 0;

  for (const part of parts) {
    const type = typeof part?.type === "string" ? part.type : "unknown";
    partTypes[type] = (partTypes[type] ?? 0) + 1;

    const partSize = getJsonSize(part);
    if (partSize > largestPartSize) {
      largestPartType = type;
      largestPartSize = partSize;
    }

    if (type === "text" && typeof part.text === "string") {
      textChars += part.text.length;
    }
    if (type === "reasoning" && typeof part.text === "string") {
      reasoningChars += part.text.length;
    }
    if (type.startsWith("tool-") || type === "dynamic-tool") toolPartCount++;
    if (type.startsWith("data-")) dataPartCount++;
  }

  return {
    part_count: parts.length,
    parts_json_chars: getJsonSize(parts),
    part_types: partTypes,
    largest_part_type: largestPartType,
    largest_part_json_chars: largestPartSize,
    text_chars: textChars,
    reasoning_chars: reasoningChars,
    tool_part_count: toolPartCount,
    data_part_count: dataPartCount,
  };
};

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

/**
 * Helper function to check if deleted messages invalidate the chat summary
 * Clears latest_summary_id if the summary's cutoff message was deleted
 */
const tryFallbackSummary = async (
  ctx: MutationCtx,
  summaryId: Id<"chat_summaries">,
  previousSummaries: {
    summary_text: string;
    summary_up_to_message_id: string;
    summary_up_to_message_creation_time?: number;
    retained_tail?: RetainedTailDoc;
  }[],
  earliestDeletedTime: number,
): Promise<boolean> => {
  // Batch-fetch all cutoff messages in one pass
  const cutoffMessages = await Promise.all(
    previousSummaries.map((s) =>
      ctx.db
        .query("messages")
        .withIndex("by_message_id", (q) =>
          q.eq("id", s.summary_up_to_message_id),
        )
        .first(),
    ),
  );

  // Find the first candidate whose cutoff message still exists and predates the deletion
  for (let i = 0; i < previousSummaries.length; i++) {
    const cutoffMsg = cutoffMessages[i];
    const retainedTailStartId =
      previousSummaries[i].retained_tail?.start_message_id;
    const retainedTailStartExists =
      !retainedTailStartId ||
      retainedTailStartId === previousSummaries[i].summary_up_to_message_id ||
      !!(await ctx.db
        .query("messages")
        .withIndex("by_message_id", (q) => q.eq("id", retainedTailStartId))
        .first());

    if (
      cutoffMsg &&
      retainedTailStartExists &&
      cutoffMsg._creationTime < earliestDeletedTime
    ) {
      await ctx.db.patch(summaryId, {
        summary_text: previousSummaries[i].summary_text,
        summary_up_to_message_id: previousSummaries[i].summary_up_to_message_id,
        summary_up_to_message_creation_time: cutoffMsg._creationTime,
        retained_tail: previousSummaries[i].retained_tail,
        previous_summaries: previousSummaries.slice(i + 1),
      });
      return true;
    }
  }
  return false;
};

const checkAndInvalidateSummary = async (
  ctx: MutationCtx,
  chatId: string,
  deletedMessages: { id: string; creationTime: number }[],
) => {
  if (deletedMessages.length === 0) return;

  try {
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", chatId))
      .first();

    if (!chat || !chat.latest_summary_id) return;

    const summary = await ctx.db.get(chat.latest_summary_id);
    if (!summary) return;

    const previousSummaries: {
      summary_text: string;
      summary_up_to_message_id: string;
      summary_up_to_message_creation_time?: number;
      retained_tail?: RetainedTailDoc;
    }[] = summary.previous_summaries ?? [];

    const earliestDeletedTime = Math.min(
      ...deletedMessages.map((m) => m.creationTime),
    );

    const cutoffMessage = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) =>
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
      });
      try {
        await ctx.db.delete(chat.latest_summary_id);
      } catch (error) {
        console.error("[Messages] Failed to delete orphaned summary:", error);
      }
      return;
    }

    const retainedTailStartMessageId = summary.retained_tail?.start_message_id;
    const retainedTailStartMessage =
      retainedTailStartMessageId &&
      retainedTailStartMessageId !== summary.summary_up_to_message_id
        ? await ctx.db
            .query("messages")
            .withIndex("by_message_id", (q) =>
              q.eq("id", retainedTailStartMessageId),
            )
            .first()
        : retainedTailStartMessageId === summary.summary_up_to_message_id
          ? cutoffMessage
          : null;

    if (retainedTailStartMessageId && !retainedTailStartMessage) {
      const found = await tryFallbackSummary(
        ctx,
        chat.latest_summary_id,
        previousSummaries,
        earliestDeletedTime,
      );
      if (found) return;

      await ctx.db.patch(chat._id, {
        latest_summary_id: undefined,
      });
      try {
        await ctx.db.delete(chat.latest_summary_id);
      } catch (error) {
        console.error("[Messages] Failed to delete stale summary:", error);
      }
      return;
    }

    const shouldInvalidate = deletedMessages.some(
      (msg) =>
        msg.creationTime <= cutoffMessage._creationTime ||
        (retainedTailStartMessageId != null &&
          msg.id === retainedTailStartMessageId),
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

const clearChatSummaries = async (ctx: any, chatId: string) => {
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q: any) => q.eq("id", chatId))
    .first();

  if (chat?.latest_summary_id) {
    await ctx.db.patch(chat._id, {
      latest_summary_id: undefined,
    });
  }

  const summaries = await ctx.db
    .query("chat_summaries")
    .withIndex("by_chat_id", (q: any) => q.eq("chat_id", chatId))
    .collect();

  for (const summary of summaries) {
    try {
      await ctx.db.delete(summary._id);
    } catch (error) {
      console.error(`Failed to delete summary ${summary._id}:`, error);
    }
  }
};

export const verifyChatOwnership = internalQuery({
  args: {
    chatId: v.string(),
    userId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await loadOwnedChat(ctx, args.chatId, args.userId);
    return true;
  },
});

async function loadOwnedChat(
  ctx: { db: GenericDatabaseReader<DataModel> },
  chatId: string,
  userId: string,
): Promise<Doc<"chats">> {
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q) => q.eq("id", chatId))
    .first();

  if (!chat) {
    throw new ConvexError({
      code: "CHAT_NOT_FOUND",
      message: "This chat doesn't exist",
    });
  }

  if (chat.user_id !== userId) {
    throw new ConvexError({
      code: "CHAT_UNAUTHORIZED",
      message: "You don't have permission to access this chat",
    });
  }

  return chat;
}

async function ensureChatWritableForMessageInsert(
  ctx: MutationCtx,
  chatId: string,
  userId: string,
  role: "user" | "assistant" | "system",
): Promise<void> {
  const chat = await loadOwnedChat(ctx, chatId, userId);

  if (chat.canceled_at !== undefined) {
    if (role === "user") {
      await ctx.db.patch(chat._id, {
        canceled_at: undefined,
      });
      return;
    }

    throw new ConvexError({
      code: "CHAT_CANCELED",
      message: "This chat is no longer accepting new messages",
    });
  }
}

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
    mode: v.optional(v.union(v.literal("agent"), v.literal("ask"))),
    generationStartedAt: v.optional(v.number()),
    generationTimeMs: v.optional(v.number()),
    finishReason: v.optional(v.string()),
    usage: v.optional(v.any()),
    updateOnly: v.optional(v.boolean()),
    isHidden: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    let failureStage = "start";

    try {
      const ensureOwnedFiles = async (
        fileIds: Id<"files">[] | undefined,
      ): Promise<Doc<"files">[]> => {
        if (!fileIds || fileIds.length === 0) return [];

        const files = await Promise.all(
          fileIds.map((fileId) =>
            ctx.db.get(fileId).catch((error) => {
              console.error(
                `Failed to read file ${fileId} while validating ownership:`,
                error,
              );
              return null;
            }),
          ),
        );

        for (let i = 0; i < fileIds.length; i++) {
          const file = files[i];
          if (!file) {
            throw new Error("File not found");
          }
          if (file.user_id !== args.userId) {
            throw new Error("File does not belong to user");
          }
        }

        return files as Doc<"files">[];
      };
      const explicitFileIds = new Set(args.fileIds ?? []);
      const partOnlyFileIds = Array.from(
        new Set(
          extractFileIdsFromParts(args.parts).filter(
            (fileId) => !explicitFileIds.has(fileId),
          ),
        ),
      );
      if (partOnlyFileIds.length > 0) {
        failureStage = "verify_file_part_ownership";
        await ensureOwnedFiles(partOnlyFileIds);
      }
      const fileIdsForSave = args.fileIds;
      const partsForSave = args.parts;

      failureStage = "find_existing_message";
      const existingMessage = await ctx.db
        .query("messages")
        .withIndex("by_message_id", (q) => q.eq("id", args.id))
        .first();

      if (existingMessage) {
        if (
          existingMessage.chat_id !== args.chatId ||
          existingMessage.user_id !== args.userId
        ) {
          failureStage = "verify_existing_message_ownership";
          throw new ConvexError({
            code: "MESSAGE_UNAUTHORIZED",
            message: "You don't have permission to update this message",
          });
        }

        // Build patch for fields that need updating
        const patch: Record<string, unknown> = {};

        // Add new fileIds if provided
        if (fileIdsForSave && fileIdsForSave.length > 0) {
          const currentFileIds = existingMessage.file_ids || [];
          const newFileIds = fileIdsForSave.filter(
            (id) => !currentFileIds.includes(id),
          );

          if (newFileIds.length > 0) {
            failureStage = "validate_existing_message_file_ownership";
            const files = await ensureOwnedFiles(newFileIds);
            patch.file_ids = [...currentFileIds, ...newFileIds];

            // Batch-read files in parallel, then only patch those that still
            // need the attached flag set. Skipping no-op patches avoids
            // invalidating the `by_is_attached` index for already-attached
            // files that just got referenced from another message.
            for (const file of files) {
              if (!file.is_attached) {
                failureStage = "patch_existing_message_file_attachment";
                await ctx.db.patch(file._id, { is_attached: true });
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
        if (args.mode && !existingMessage.mode) {
          patch.mode = args.mode;
        }
        if (
          typeof args.generationStartedAt === "number" &&
          typeof existingMessage.generation_started_at !== "number"
        ) {
          patch.generation_started_at = args.generationStartedAt;
        }
        if (
          typeof args.generationTimeMs === "number" &&
          typeof existingMessage.generation_time_ms !== "number"
        ) {
          patch.generation_time_ms = args.generationTimeMs;
        }
        if (args.finishReason && !existingMessage.finish_reason) {
          patch.finish_reason = args.finishReason;
        }
        if (args.isHidden !== undefined) {
          patch.is_hidden = args.isHidden;
        }

        // Apply patch if there are changes
        if (Object.keys(patch).length > 0) {
          patch.update_time = Date.now();
          failureStage = "patch_existing_message";
          await ctx.db.patch(existingMessage._id, patch);
        }

        return null;
      } else {
        // updateOnly: only patch existing messages, don't create new ones.
        // Safety net for aborted streams when Redis skipSave signal was missed.
        if (args.updateOnly) {
          return null;
        }

        failureStage = "verify_chat_writable_for_insert";
        await ensureChatWritableForMessageInsert(
          ctx,
          args.chatId,
          args.userId,
          args.role,
        );
      }

      let newMessageFiles: Doc<"files">[] = [];
      if (fileIdsForSave && fileIdsForSave.length > 0) {
        failureStage = "validate_new_message_file_ownership";
        newMessageFiles = await ensureOwnedFiles(fileIdsForSave);
      }

      failureStage = "extract_content";
      const content = extractTextFromParts(partsForSave);

      const messageDocumentBase = {
        id: args.id,
        chat_id: args.chatId,
        user_id: args.userId,
        role: args.role,
        parts: partsForSave,
        file_ids: fileIdsForSave,
        update_time: Date.now(),
        model: args.model,
        mode: args.mode,
        generation_started_at: args.generationStartedAt,
        generation_time_ms: args.generationTimeMs,
        finish_reason: args.finishReason,
        usage: args.usage,
        is_hidden: args.isHidden,
      };
      failureStage = "prepare_insert_message";
      const baseDocumentSizeBytes = getMessageDocumentSize(messageDocumentBase);
      if (baseDocumentSizeBytes > MESSAGE_DOCUMENT_TARGET_BYTES) {
        throw new ConvexError({
          code: "MESSAGE_TOO_LARGE",
          message: "Message is too large to save",
          failureStage: "prepare_insert_message",
          baseDocumentSizeBytes,
          maxDocumentSizeBytes: CONVEX_DOCUMENT_MAX_BYTES,
          targetDocumentSizeBytes: MESSAGE_DOCUMENT_TARGET_BYTES,
          operation: "messages.saveMessage",
          chatId: args.chatId,
          messageId: args.id,
          role: args.role,
          fileCount: args.fileIds?.length ?? 0,
          ...getMessageSaveDiagnostics(args.parts),
        });
      }

      const indexedContent =
        content.length > 0
          ? fitSearchContentToDocument(messageDocumentBase, content)
          : null;

      if (
        indexedContent &&
        indexedContent.content !== undefined &&
        indexedContent.content.length < content.length
      ) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "message_search_content_truncated_for_storage",
            service: "convex",
            timestamp: new Date().toISOString(),
            db_operation: "messages.saveMessage",
            chat_id: args.chatId,
            user_id: args.userId,
            message_id: args.id,
            message_role: args.role,
            full_content_chars: content.length,
            indexed_content_chars: indexedContent.content.length,
            base_document_size_bytes: baseDocumentSizeBytes,
            full_document_size_bytes: indexedContent.fullSizeBytes,
            indexed_document_size_bytes: indexedContent.indexedSizeBytes,
          }),
        );
      } else if (indexedContent && indexedContent.content === undefined) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "message_search_content_omitted_for_storage",
            service: "convex",
            timestamp: new Date().toISOString(),
            db_operation: "messages.saveMessage",
            chat_id: args.chatId,
            user_id: args.userId,
            message_id: args.id,
            message_role: args.role,
            full_content_chars: content.length,
            base_document_size_bytes: baseDocumentSizeBytes,
            full_document_size_bytes: indexedContent.fullSizeBytes,
          }),
        );
      }

      failureStage = "insert_message";
      await ctx.db.insert("messages", {
        ...messageDocumentBase,
        content: indexedContent?.content,
      });

      // Mark attached files as linked so purge won't remove them.
      // Batch-read in parallel, skip no-op patches when already attached.
      for (const file of newMessageFiles) {
        if (!file.is_attached) {
          failureStage = "patch_new_message_file_attachment";
          await ctx.db.patch(file._id, { is_attached: true });
        }
      }

      return null;
    } catch (error) {
      const causeData = getConvexErrorData(error);
      if (getConvexErrorCode(causeData) === "MESSAGE_TOO_LARGE") {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "convex_message_save_rejected_too_large",
            service: "convex",
            timestamp: new Date().toISOString(),
            db_operation: "messages.saveMessage",
            failure_stage: failureStage,
            chat_id: args.chatId,
            user_id: args.userId,
            message_id: args.id,
            message_role: args.role,
            mode: args.mode,
            update_only: args.updateOnly === true,
            hidden: args.isHidden === true,
            file_count: args.fileIds?.length ?? 0,
            convex_error_data: causeData,
            ...getMessageSaveDiagnostics(args.parts),
          }),
        );
        throw error;
      }

      if (
        failureStage === "verify_chat_writable_for_insert" &&
        args.role === "assistant" &&
        (getConvexErrorCode(causeData) === "CHAT_NOT_FOUND" ||
          getConvexErrorCode(causeData) === "CHAT_CANCELED")
      ) {
        const convexErrorCode = getConvexErrorCode(causeData);
        console.warn(
          JSON.stringify({
            level: "warn",
            event:
              convexErrorCode === "CHAT_CANCELED"
                ? "convex_message_save_skipped_chat_canceled"
                : "convex_message_save_skipped_chat_not_found",
            service: "convex",
            timestamp: new Date().toISOString(),
            db_operation: "messages.saveMessage",
            failure_stage: failureStage,
            chat_id: args.chatId,
            user_id: args.userId,
            message_id: args.id,
            message_role: args.role,
            mode: args.mode,
            model: args.model,
            finish_reason: args.finishReason,
            update_only: args.updateOnly === true,
            hidden: args.isHidden === true,
            file_count: args.fileIds?.length ?? 0,
            convex_error_code: convexErrorCode,
            ...getMessageSaveDiagnostics(args.parts),
          }),
        );
        return null;
      }

      console.error(
        JSON.stringify({
          level: "error",
          event: "convex_message_save_failed",
          service: "convex",
          timestamp: new Date().toISOString(),
          db_operation: "messages.saveMessage",
          failure_stage: failureStage,
          chat_id: args.chatId,
          user_id: args.userId,
          message_id: args.id,
          message_role: args.role,
          mode: args.mode,
          model: args.model,
          finish_reason: args.finishReason,
          update_only: args.updateOnly === true,
          hidden: args.isHidden === true,
          file_count: args.fileIds?.length ?? 0,
          error_name: getErrorName(error),
          error_message: getErrorMessage(error),
          convex_error_data: causeData,
          ...getMessageSaveDiagnostics(args.parts),
        }),
      );
      throw new ConvexError({
        code: "MESSAGE_SAVE_FAILED",
        message: "Failed to save message",
        failureStage,
        causeName: getErrorName(error),
        causeMessage: getErrorMessage(error),
        causeData,
        operation: "messages.saveMessage",
        chatId: args.chatId,
        messageId: args.id,
        role: args.role,
        mode: args.mode,
        finishReason: args.finishReason,
        updateOnly: args.updateOnly === true,
        hidden: args.isHidden === true,
        fileCount: args.fileIds?.length ?? 0,
        ...getMessageSaveDiagnostics(args.parts),
      });
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
        chat_id: v.string(),
        role: v.union(
          v.literal("user"),
          v.literal("assistant"),
          v.literal("system"),
        ),
        parts: v.array(v.any()),
        created_at: v.number(),
        source_message_id: v.optional(v.string()),
        feedback: v.union(
          v.object({
            feedbackType: v.union(v.literal("positive"), v.literal("negative")),
          }),
          v.null(),
        ),
        generation_time_ms: v.optional(v.number()),
        generation_started_at: v.optional(v.number()),
        mode: v.optional(v.union(v.literal("agent"), v.literal("ask"))),
        fileDetails: v.optional(
          v.array(
            v.object({
              fileId: v.id("files"),
              name: v.string(),
              mediaType: v.optional(v.string()),
              url: v.optional(v.union(v.string(), v.null())),
              s3Key: v.optional(v.string()),
              sizeBytes: v.optional(v.number()),
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
    await assertUserCanAccessChatHistory(ctx, user.subject);

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

      // Filter hidden messages (e.g. auto-continue rows) from the page.
      // This is applied post-pagination; hidden messages are rare so page
      // sizes remain effectively unchanged.
      const visiblePage = result.page.filter((m) => m.is_hidden !== true);

      // OPTIMIZATION: Batch fetch all files and URLs upfront to avoid N+1 queries

      // Step 1: Collect all unique file IDs from all messages
      const allFileIds = new Set<Id<"files">>();
      for (const message of visiblePage) {
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
      // Only file metadata (fileId, name, mediaType, s3Key) is returned.
      const fileDetailsMap = new Map();
      files.forEach((file, index) => {
        if (file && file.user_id === user.subject) {
          fileDetailsMap.set(fileIdArray[index], {
            fileId: fileIdArray[index],
            name: file.name,
            mediaType: file.media_type,
            // url: removed - generate on-demand to avoid caching expired URLs
            s3Key: file.s3_key,
            sizeBytes: file.size,
          });
        }
      });

      // Step 5: Build enhanced messages using the lookup map
      const enhancedMessages = [];
      for (const message of visiblePage) {
        // Get feedback if exists
        let feedback = null;
        if (message.role === "assistant" && message.feedback_id) {
          const feedbackDoc = await ctx.db.get(message.feedback_id);
          if (feedbackDoc) {
            feedback = {
              feedbackType: feedbackDoc.feedback_type as
                "positive" | "negative",
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
          chat_id: message.chat_id,
          role: message.role,
          parts: message.parts,
          created_at: message._creationTime,
          source_message_id: message.source_message_id,
          feedback,
          mode: message.mode,
          generation_started_at: message.generation_started_at,
          generation_time_ms: message.generation_time_ms,
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
    mode: v.optional(v.union(v.literal("agent"), v.literal("ask"))),
    generationStartedAt: v.optional(v.number()),
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
    await assertUserCanAccessChatHistory(ctx, user.subject);

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
        mode: args.mode,
        generation_started_at: args.generationStartedAt,
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
    resetSummary: v.optional(v.boolean()),
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
    await assertUserCanAccessChatHistory(ctx, user.subject);

    try {
      // Walk backwards from newest message and collect the entire trailing chain:
      // assistant messages + hidden (auto-continue) user messages.
      // Stop at the first non-hidden user message so regenerate targets the original request.
      const trailingMessages = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
        .order("desc")
        .collect();

      const messagesToDelete: typeof trailingMessages = [];
      for (const msg of trailingMessages) {
        if (msg.role === "assistant") {
          messagesToDelete.push(msg);
        } else if (msg.role === "user" && msg.is_hidden) {
          messagesToDelete.push(msg);
        } else {
          break;
        }
      }

      if (messagesToDelete.length > 0) {
        const firstMsg = messagesToDelete[0];
        if (firstMsg.user_id && firstMsg.user_id !== user.subject) {
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

        if (args.resetSummary) {
          await clearChatSummaries(ctx, args.chatId);
        } else {
          // Check summary invalidation for all messages being deleted
          await checkAndInvalidateSummary(
            ctx,
            args.chatId,
            messagesToDelete.map((m) => ({
              id: m.id,
              creationTime: m._creationTime,
            })),
          );
        }

        // Delete files and messages
        for (const msg of messagesToDelete) {
          if (msg.file_ids && msg.file_ids.length > 0) {
            for (const fileId of msg.file_ids) {
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
          if (msg.feedback_id) {
            try {
              await ctx.db.delete(msg.feedback_id);
            } catch (error) {
              console.error(
                `Failed to delete feedback ${msg.feedback_id}:`,
                error,
              );
            }
          }
          await ctx.db.delete(msg._id);
        }
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
      metadata: v.optional(
        v.object({
          generationStartedAt: v.optional(v.number()),
          generationTimeMs: v.optional(v.number()),
          mode: v.optional(v.union(v.literal("agent"), v.literal("ask"))),
        }),
      ),
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
        metadata:
          message.mode ||
          typeof message.generation_started_at === "number" ||
          typeof message.generation_time_ms === "number"
            ? {
                ...(message.mode ? { mode: message.mode } : {}),
                ...(typeof message.generation_started_at === "number"
                  ? { generationStartedAt: message.generation_started_at }
                  : {}),
                ...(typeof message.generation_time_ms === "number"
                  ? { generationTimeMs: message.generation_time_ms }
                  : {}),
              }
            : undefined,
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

    const visiblePage = result.page.filter(
      (message) => message.is_hidden !== true,
    );
    const fileIds = new Set<Id<"files">>();
    for (const message of visiblePage) {
      extractFileIdsFromParts(message.parts).forEach((fileId) =>
        fileIds.add(fileId),
      );
    }
    const ownedFileIds = await getOwnedFileIdSet(
      ctx,
      Array.from(fileIds),
      args.userId,
    );

    return {
      page: visiblePage.map((message) => ({
        id: message.id,
        role: message.role,
        parts: stripUnownedFileParts(message.parts, ownedFileIds),
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
    await assertUserCanAccessChatHistory(ctx, user.subject);

    const searchQuery = args.searchQuery
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, MAX_MESSAGE_SEARCH_QUERY_LENGTH);

    if (!searchQuery || searchQuery.length < MIN_MESSAGE_SEARCH_QUERY_LENGTH) {
      return {
        page: [],
        isDone: true,
        continueCursor: "",
      };
    }

    try {
      // Cap raw result sets to keep bandwidth predictable. Search relevance
      // ordering means the top results per index cover the visible pages while
      // avoiding broad-query Convex search timeouts.
      const SEARCH_RESULT_CAP = 75;
      const SEARCH_CHAT_METADATA_CAP = 50;

      const searchStartedAt = Date.now();
      const [messageSearch, chatSearch] = await Promise.allSettled([
        ctx.db
          .query("messages")
          .withSearchIndex("search_content", (q) =>
            q.search("content", searchQuery).eq("user_id", user.subject),
          )
          .take(SEARCH_RESULT_CAP),
        ctx.db
          .query("chats")
          .withSearchIndex("search_title", (q) =>
            q.search("title", searchQuery).eq("user_id", user.subject),
          )
          .take(SEARCH_RESULT_CAP),
      ]);

      const failedIndexes: Array<{ index: string; error: string }> = [];
      if (messageSearch.status === "rejected") {
        failedIndexes.push({
          index: "messages.search_content",
          error: getErrorMessage(messageSearch.reason),
        });
      }
      if (chatSearch.status === "rejected") {
        failedIndexes.push({
          index: "chats.search_title",
          error: getErrorMessage(chatSearch.reason),
        });
      }

      if (failedIndexes.length > 0) {
        convexLogger.warn("message_search_index_failed", {
          user_id: user.subject,
          query_length: searchQuery.length,
          failed_indexes: failedIndexes,
          duration_ms: Date.now() - searchStartedAt,
        });
      }

      const messageResults =
        messageSearch.status === "fulfilled" ? messageSearch.value : [];
      const chatResults =
        chatSearch.status === "fulfilled" ? chatSearch.value : [];

      if (messageResults.length === 0 && chatResults.length === 0) {
        return {
          page: [],
          isDone: true,
          continueCursor: "",
        };
      }

      // Filter out hidden messages from search results
      const visibleMessageResults = messageResults.filter(
        (msg) => msg.is_hidden !== true,
      );

      // Create a map to track which chats have message matches
      const messageChatIds = new Set(
        visibleMessageResults.map((msg) => msg.chat_id),
      );

      // Resolve chat metadata for every unique chat referenced by a message
      // match in a single batch, replacing N+1 per-message lookups.
      const chatById = new Map<string, { title: string; update_time: number }>(
        chatResults.map((c) => [
          c.id,
          { title: c.title, update_time: c.update_time },
        ]),
      );
      const missingChatIds = [...messageChatIds].filter(
        (id) => !chatById.has(id),
      );
      if (missingChatIds.length > 0) {
        if (missingChatIds.length > SEARCH_CHAT_METADATA_CAP) {
          convexLogger.warn("message_search_metadata_cap_reached", {
            user_id: user.subject,
            query_length: searchQuery.length,
            missing_chat_count: missingChatIds.length,
            metadata_cap: SEARCH_CHAT_METADATA_CAP,
          });
        }

        const fetched = await Promise.allSettled(
          missingChatIds.slice(0, SEARCH_CHAT_METADATA_CAP).map((id) =>
            ctx.db
              .query("chats")
              .withIndex("by_chat_id", (q) => q.eq("id", id))
              .first(),
          ),
        );
        const metadataFailures = fetched.filter(
          (result) => result.status === "rejected",
        );
        if (metadataFailures.length > 0) {
          convexLogger.warn("message_search_metadata_fetch_failed", {
            user_id: user.subject,
            query_length: searchQuery.length,
            failed_count: metadataFailures.length,
            requested_count: fetched.length,
          });
        }

        for (const result of fetched) {
          if (result.status === "fulfilled" && result.value) {
            chatById.set(result.value.id, {
              title: result.value.title,
              update_time: result.value.update_time,
            });
          }
        }
      }

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
      for (const msg of visibleMessageResults) {
        const chat = chatById.get(msg.chat_id);

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

      // Add chat title results (only if not already added via message).
      // We skip the "recent message preview" lookup to avoid an N+1 per
      // title-only match — clients render the chat title itself in that row.
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
          combinedResults.push({
            id: `title-${chat.id}`,
            chat_id: chat.id,
            content: "",
            created_at: chat._creationTime,
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
      convexLogger.error("message_search_failed", {
        user_id: user.subject,
        query_length: searchQuery.length,
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
 * Branch chat from a specific message - creates a new chat with messages up to and including the specified message
 */
export const branchChat = mutation({
  args: {
    messageId: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new Error("Unauthorized: User not authenticated");
    }
    await assertUserCanAccessChatHistory(ctx, user.subject);

    try {
      const message = await ctx.db
        .query("messages")
        .withIndex("by_message_id", (q) => q.eq("id", args.messageId))
        .first();

      if (!message) {
        convexLogger.warn("branch_chat_message_missing", {
          user_id: user.subject,
          message_id: args.messageId,
        });
        return null;
      }

      if (message.user_id !== user.subject) {
        convexLogger.warn("branch_chat_message_access_denied", {
          user_id: user.subject,
          message_id: args.messageId,
        });
        return null;
      }

      const chatExists: boolean = await ctx.runQuery(
        internal.messages.verifyChatOwnership,
        {
          chatId: message.chat_id,
          userId: user.subject,
        },
      );

      if (!chatExists) {
        convexLogger.warn("branch_chat_chat_missing_or_denied", {
          user_id: user.subject,
          message_id: args.messageId,
          chat_id: message.chat_id,
        });
        return null;
      }

      // Get original chat to copy title
      const originalChat = await ctx.db
        .query("chats")
        .withIndex("by_chat_id", (q) => q.eq("id", message.chat_id))
        .first();

      if (!originalChat) {
        convexLogger.warn("branch_chat_original_chat_missing", {
          user_id: user.subject,
          message_id: args.messageId,
          chat_id: message.chat_id,
        });
        return null;
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

      const newChatDocId = await ctx.db.insert("chats", {
        id: newChatId,
        title: originalChat.title,
        user_id: user.subject,
        branched_from_chat_id: message.chat_id,
        project_id: originalChat.project_id,
        update_time: Date.now(),
      });

      // Copy messages to new chat, tracking old→new ID mapping for summary remapping
      const messageIdMap = new Map<string, string>();
      for (const msg of messagesToCopy) {
        const newMessageId = crypto.randomUUID();
        messageIdMap.set(msg.id, newMessageId);
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
          mode: msg.mode,
          generation_started_at: msg.generation_started_at,
          generation_time_ms: msg.generation_time_ms,
          finish_reason: msg.finish_reason,
          usage: msg.usage,
        });
      }

      // Copy summary from original chat if it covers the copied messages
      if (originalChat.latest_summary_id) {
        await copyChatSummary(ctx.db, {
          sourceSummaryId: originalChat.latest_summary_id,
          targetChatDocId: newChatDocId,
          targetChatId: newChatId,
          messageIdMap,
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
    await assertUserCanAccessChatHistory(ctx, user.subject);

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
            }
          }
        }

        if (msg.feedback_id) {
          try {
            await ctx.db.delete(msg.feedback_id);
          } catch (error) {
            console.error(
              `Failed to delete feedback ${msg.feedback_id}:`,
              error,
            );
          }
        }

        await ctx.db.delete(msg._id);
      }

      return null;
    } catch (error) {
      // Only log unexpected errors. "Message not found" is treated as a benign no-op above.
      if (!(
        error instanceof Error &&
        (error.message.includes("Message not found") ||
          error.message.includes("CHAT_NOT_FOUND") ||
          error.message.includes("CHAT_UNAUTHORIZED"))
      )) {
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
      if (await isUserBlockedByActiveFraudDispute(ctx, chat.user_id)) {
        return [];
      }

      // Read the chat's messages via the existing per-chat index, then apply
      // the frozen-share cutoff locally to avoid a production-wide backfill.
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
        .order("asc")
        .collect();

      // FROZEN CONTENT: Exclude hidden messages (e.g. auto-continue rows).
      const frozenMessages = messages
        .filter(
          (msg) =>
            msg.update_time <= chat.share_date! && msg.is_hidden !== true,
        )
        .sort(
          (a, b) =>
            a.update_time - b.update_time || a._creationTime - b._creationTime,
        );

      // Strip sensitive data and replace files with placeholders
      return frozenMessages.map((msg) => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        update_time: msg.update_time,
        // Process parts to replace files/images with placeholders
        parts: stripOpenRouterReasoningMetadataFromParts(msg.parts).map(
          (part: any) => {
            // Replace file references with placeholder
            if (part.type === "file") {
              // Determine if it's an image based on mediaType
              const isImage = part.mediaType?.startsWith("image/");
              return {
                type: isImage ? "image" : "file",
                placeholder: true,
                // SECURITY: Do NOT include url, file_id, name, or mediaType
              };
            }
            // Keep text parts as-is
            return part;
          },
        ),
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
      parts: v.array(v.any()),
      fileDetails: v.optional(
        v.array(
          v.object({
            fileId: v.id("files"),
            name: v.string(),
            mediaType: v.optional(v.string()),
            s3Key: v.optional(v.string()),
            sizeBytes: v.optional(v.number()),
          }),
        ),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }
    await assertUserCanAccessChatHistory(ctx, identity.subject);

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

      // Get first 4 visible messages (user and assistant messages only)
      const visibleMessages = messages
        .filter(
          (m) =>
            m.is_hidden !== true &&
            (m.role === "user" || m.role === "assistant"),
        )
        .slice(0, 4);

      // Batch fetch file details for messages with file_ids
      const allFileIds = new Set<Id<"files">>();
      for (const message of visibleMessages) {
        if (message.file_ids && message.file_ids.length > 0) {
          message.file_ids.forEach((id) => allFileIds.add(id));
        }
      }

      const fileIdArray = Array.from(allFileIds);
      const files = await Promise.all(
        fileIdArray.map((fileId) => ctx.db.get(fileId)),
      );

      const fileDetailsMap = new Map();
      files.forEach((file, index) => {
        if (file && file.user_id === identity.subject) {
          fileDetailsMap.set(fileIdArray[index], {
            fileId: fileIdArray[index],
            name: file.name,
            mediaType: file.media_type,
            s3Key: file.s3_key,
            sizeBytes: file.size,
          });
        }
      });

      const result = visibleMessages.map((m) => {
        let fileDetails = undefined;
        if (m.file_ids && m.file_ids.length > 0) {
          fileDetails = m.file_ids
            .map((fileId) => fileDetailsMap.get(fileId))
            .filter((detail) => detail !== undefined);
        }

        return {
          id: m.id,
          role: m.role,
          content: m.content,
          parts: stripOpenRouterReasoningMetadataFromParts(m.parts),
          fileDetails,
        };
      });

      return result;
    } catch (error) {
      console.error("Failed to get preview messages:", error);
      return [];
    }
  },
});
