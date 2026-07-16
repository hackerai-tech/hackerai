import "server-only";

import { api } from "@/convex/_generated/api";
import { ChatSDKError } from "../errors";
import { getConvexClient, setConvexUrl } from "./convex-client";
import { UIMessage, UIMessagePart } from "ai";
import { extractFileIdsFromParts } from "@/lib/utils/file-token-utils";
import {
  extractAllFileIdsFromMessages,
  getFileTokensByIds,
  truncateMessagesWithFileTokens,
} from "@/lib/utils/file-token-utils";
import {
  countMessagesTokens,
  getMaxTokensForSubscription,
  truncateMessagesToTokenLimit,
} from "@/lib/token-utils";
import { fixIncompleteMessageParts } from "@/lib/chat/chat-processor";
import { compactMessageForStorage } from "@/lib/chat/compaction/prune-tool-outputs";
import type {
  AgentToolApprovalPendingRequest,
  SubscriptionTier,
  NoteCategory,
} from "@/types";
import type { Id } from "@/convex/_generated/dataModel";
import { v4 as uuidv4 } from "uuid";
import { AGENT_RESUME_PREAMBLE } from "@/lib/chat/summarization/prompts";
import {
  projectMessagesToTokenBudget,
  projectRetainedTailFromMessages,
  type RetainedTailMetadata,
} from "@/lib/chat/summarization/retained-tail";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import { hasRestageableLocalDesktopAttachments } from "@/lib/utils/local-attachment-messages";
import type { ChatMode } from "@/types/chat";
import { getMessagePersistenceDiagnostics } from "./message-persistence-diagnostics";
import { sanitizeForConvexValue } from "./convex-value-sanitizer";
import { stringifyRedactedError } from "@/lib/utils/error-redaction";
import { phLogger } from "@/lib/posthog/server";
import { stripOpenRouterReasoningMetadataFromParts } from "@/lib/chat/provider-metadata-sanitizer";
import type { UsageDeductionFailureReason } from "@/lib/rate-limit";
import type { ChatApiEndpoint } from "@/lib/api/agent-endpoints";
import type { PersistedAgentApprovalTargetGrant } from "@/lib/chat/agent-approval-grants";

const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;
const MAX_DATABASE_ERROR_MESSAGE_LENGTH = 500;
const MAX_DATABASE_ERROR_DATA_STRING_LENGTH = 500;
const MAX_DATABASE_ERROR_DATA_BYTES = 4 * 1024;
const MAX_DATABASE_ERROR_DATA_DEPTH = 3;
const MAX_DATABASE_ERROR_DATA_ARRAY_LENGTH = 20;
const LARGE_MESSAGE_SAVE_WARNING_BYTES = 850 * 1024;
const SAVE_MESSAGE_RETRY_DELAYS_MS =
  process.env.NODE_ENV === "test" ? [0, 0] : [250, 1000];
const SAVE_CHAT_RETRY_DELAYS_MS =
  process.env.NODE_ENV === "test" ? [0, 0] : [250, 1000];
const UPDATE_CHAT_RETRY_DELAYS_MS =
  process.env.NODE_ENV === "test" ? [0, 0] : [250, 1000];
const GET_CHAT_RETRY_DELAYS_MS =
  process.env.NODE_ENV === "test" ? [0, 0] : [250, 1000];
const GET_MESSAGES_PAGE_RETRY_DELAYS_MS =
  process.env.NODE_ENV === "test" ? [0, 0] : [250, 1000];
const CHAT_DELETION_RETRY_DELAYS_MS =
  process.env.NODE_ENV === "test" ? [0, 0] : [250, 1000];
const MAX_CHAT_DELETION_FENCE_BATCHES = 50;
const MAX_ACTIVE_AGENT_RESOURCES_TO_RETURN = 100;
const REDACTED_ERROR_DATA_VALUE = "[Redacted]";
type ActiveAgentResource = {
  chatId: string;
  triggerRunId?: string;
  approvalSessionId?: string;
};
type ChatDeletionFencePage = {
  fencedChats: number;
  isDone: boolean;
  continueCursor: string;
  resources: ActiveAgentResource[];
};
type SummaryReason =
  "token_threshold" | "provider_input_threshold" | "provider_pressure";

const sensitiveErrorDataKeys = new Set([
  "authorization",
  "body",
  "content",
  "cookie",
  "cookies",
  "file",
  "files",
  "headers",
  "messages",
  "output",
  "parts",
  "password",
  "prompt",
  "request",
  "requestbody",
  "response",
  "responsebody",
  "result",
  "text",
  "token",
]);

export { setConvexUrl };

const stringifyError = (error: unknown): string => {
  return stringifyRedactedError(error);
};

const getErrorData = (error: unknown): unknown => {
  if (!error || typeof error !== "object") return undefined;
  const data = (error as { data?: unknown }).data;
  return data === undefined ? undefined : sanitizeErrorData(data);
};

const getJsonByteLength = (value: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf-8");
  } catch {
    return 0;
  }
};

const truncateErrorDataString = (value: string): string =>
  value.length > MAX_DATABASE_ERROR_DATA_STRING_LENGTH
    ? `${value.slice(0, MAX_DATABASE_ERROR_DATA_STRING_LENGTH)}...`
    : value;

const isSensitiveErrorDataKey = (key: string): boolean => {
  const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
  return (
    sensitiveErrorDataKeys.has(normalized) ||
    /apikey|authorization|bearer|cookie|password|secret|servicekey/.test(
      normalized,
    )
  );
};

const summarizeErrorDataObject = (value: object) => ({
  truncated: true,
  keys: Object.keys(value).slice(0, MAX_DATABASE_ERROR_DATA_ARRAY_LENGTH),
});

const sanitizeErrorDataValue = (
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown => {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return truncateErrorDataString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (typeof value !== "object") return String(value);

  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DATABASE_ERROR_DATA_DEPTH) {
    return summarizeErrorDataObject(value);
  }

  seen.add(value);

  if (Array.isArray(value)) {
    const sanitized = value
      .slice(0, MAX_DATABASE_ERROR_DATA_ARRAY_LENGTH)
      .map((item) => sanitizeErrorDataValue(item, depth + 1, seen));
    if (value.length > MAX_DATABASE_ERROR_DATA_ARRAY_LENGTH) {
      sanitized.push({
        truncated: true,
        remaining: value.length - MAX_DATABASE_ERROR_DATA_ARRAY_LENGTH,
      });
    }
    seen.delete(value);
    return sanitized;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    sanitized[key] = isSensitiveErrorDataKey(key)
      ? REDACTED_ERROR_DATA_VALUE
      : sanitizeErrorDataValue(childValue, depth + 1, seen);
  }

  seen.delete(value);
  return sanitized;
};

const sanitizeErrorData = (data: unknown): unknown => {
  const sanitized = sanitizeErrorDataValue(data, 0, new WeakSet<object>());
  const sizeBytes = getJsonByteLength(sanitized);
  if (sizeBytes <= MAX_DATABASE_ERROR_DATA_BYTES) return sanitized;

  if (sanitized && typeof sanitized === "object") {
    return {
      truncated: true,
      size_bytes: sizeBytes,
      keys: Object.keys(sanitized).slice(
        0,
        MAX_DATABASE_ERROR_DATA_ARRAY_LENGTH,
      ),
    };
  }

  return {
    truncated: true,
    size_bytes: sizeBytes,
  };
};

const truncateDiagnosticString = (value: string): string =>
  value.length > MAX_DATABASE_ERROR_MESSAGE_LENGTH
    ? `${value.slice(0, MAX_DATABASE_ERROR_MESSAGE_LENGTH)}...`
    : value;

type UpstreamHttpError = {
  statusCode: number;
  rayId?: string;
};

const getUpstreamHttpError = (
  message: string,
): UpstreamHttpError | undefined => {
  if (!/<(?:!DOCTYPE|html)\b/i.test(message)) return undefined;
  if (!/cloudflare|cf-error-details|haiusercontent\.com/i.test(message)) {
    return undefined;
  }

  const statusMatch =
    message.match(/<title>[^<|]+\|\s*(5\d{2}):/i) ??
    message.match(/Error code\s+(5\d{2})/i);
  if (!statusMatch) return undefined;

  return {
    statusCode: Number(statusMatch[1]),
    rayId: message.match(
      /Cloudflare Ray ID:\s*(?:<[^>]+>)*\s*([a-z0-9]+)/i,
    )?.[1],
  };
};

const getDatabaseErrorDiagnostic = (error: unknown) => {
  const rawMessage = stringifyError(error);
  const upstreamHttpError = getUpstreamHttpError(rawMessage);
  if (!upstreamHttpError) {
    return {
      message: truncateDiagnosticString(rawMessage),
      upstreamHttpError: undefined,
    };
  }

  return {
    message: `Convex upstream returned HTTP ${upstreamHttpError.statusCode}`,
    upstreamHttpError,
  };
};

const getConvexRequestIdFromMessage = (message: string): string | undefined => {
  const match = message.match(/\[Request ID:\s*([^\]\s]+)\]/i);
  return match?.[1];
};

const getObjectString = (value: unknown, key: string): string | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const child = (value as Record<string, unknown>)[key];
  return typeof child === "string" ? child : undefined;
};

const getNestedObject = (
  value: unknown,
  key: string,
): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const child = (value as Record<string, unknown>)[key];
  return child && typeof child === "object" && !Array.isArray(child)
    ? (child as Record<string, unknown>)
    : undefined;
};

const getDatabasePrimaryErrorCode = (data: unknown): string | undefined =>
  getObjectString(data, "code");

const getDatabaseCauseErrorCode = (data: unknown): string | undefined =>
  getObjectString(getNestedObject(data, "causeData"), "code");

const getDatabaseErrorCode = (data: unknown): string | undefined =>
  getDatabasePrimaryErrorCode(data) ?? getDatabaseCauseErrorCode(data);

const hasDatabaseErrorCode = (data: unknown, code: string): boolean =>
  getDatabasePrimaryErrorCode(data) === code ||
  getDatabaseCauseErrorCode(data) === code;

const getDatabaseFailureStage = (data: unknown): string | undefined =>
  getObjectString(data, "failureStage");

const getRetryableDatabaseErrorReason = (
  error: unknown,
): string | undefined => {
  const rawErrorMessage = stringifyError(error);
  if (getUpstreamHttpError(rawErrorMessage)) {
    return "convex_upstream_http_5xx";
  }

  const dbErrorData = getErrorData(error);
  const dbErrorCode = getDatabaseErrorCode(dbErrorData);
  const dbCauseErrorCode = getDatabaseCauseErrorCode(dbErrorData);
  const errorText = [
    error instanceof Error ? error.name : undefined,
    rawErrorMessage,
    dbErrorCode,
    dbCauseErrorCode,
    getObjectString(dbErrorData, "causeName"),
    getObjectString(dbErrorData, "causeMessage"),
    getObjectString(dbErrorData, "message"),
  ]
    .filter(Boolean)
    .join(" ");

  if (/WorkerOverloaded/i.test(errorText)) return "worker_overloaded";
  if (/ExpiredInQueue|Too many concurrent requests/i.test(errorText)) {
    return "convex_queue_saturated";
  }
  if (
    /InternalServerError|Your request couldn't be completed\.? Try again later|Try again later/i.test(
      errorText,
    ) ||
    (!dbErrorCode && /\[Request ID:\s*[^\]]+\]\s+Server Error/i.test(errorText))
  ) {
    return "convex_server_error";
  }
  if (/failed to fetch|fetch failed/i.test(errorText)) {
    return "network_fetch_failed";
  }
  if (
    /ServiceUnavailable|temporarily unavailable|ECONNRESET|ETIMEDOUT/i.test(
      errorText,
    )
  ) {
    return "transient_service_unavailable";
  }
  if (/TooManyRequests|rate.?limit|429/i.test(errorText)) {
    return "convex_rate_limited";
  }
  return undefined;
};

const getRetryableSaveMessageErrorReason = getRetryableDatabaseErrorReason;
const getRetryableGetChatErrorReason = getRetryableDatabaseErrorReason;

const getRetryableChatDeletionErrorReason = (
  error: unknown,
): string | undefined => {
  const retryReason = getRetryableDatabaseErrorReason(error);
  if (retryReason) return retryReason;

  if (/OptimisticConcurrencyControlFailure/i.test(stringifyError(error))) {
    return "optimistic_concurrency_conflict";
  }

  return undefined;
};

const getRetryableSaveChatErrorReason = (
  error: unknown,
): string | undefined => {
  const retryReason = getRetryableDatabaseErrorReason(error);
  if (retryReason) return retryReason;

  // Older deployed Convex functions can flatten transient failures to this
  // generic shape before richer error data reaches the Next.js worker.
  if (/\[Request ID:\s*[^\]]+\]\s+Server Error/i.test(stringifyError(error))) {
    return "convex_server_error";
  }

  return undefined;
};

const getRetryableReasonForDatabaseOperation = (
  operation: string,
  error: unknown,
): string | undefined => {
  if (operation === "chats.saveChat") {
    return getRetryableSaveChatErrorReason(error);
  }
  if (
    operation === "chats.deleteChatForBackend" ||
    operation === "chats.deleteAllChatsForBackend"
  ) {
    return getRetryableChatDeletionErrorReason(error);
  }
  return getRetryableDatabaseErrorReason(error);
};

const waitForRetryDelay = (delayMs: number) =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

const runRetryableChatDeletion = async <T>({
  operation,
  metadata,
  mutation,
}: {
  operation: "chats.deleteChatForBackend" | "chats.deleteAllChatsForBackend";
  metadata: Record<string, unknown>;
  mutation: () => Promise<T>;
}): Promise<T> => {
  for (let attemptIndex = 0; ; attemptIndex++) {
    try {
      return await mutation();
    } catch (error) {
      const retryReason = getRetryableChatDeletionErrorReason(error);
      const retryDelayMs = CHAT_DELETION_RETRY_DELAYS_MS[attemptIndex];
      if (!retryReason || retryDelayMs === undefined) {
        throw error;
      }

      console.warn(
        JSON.stringify({
          level: "warn",
          event: "chat_deletion_retry_scheduled",
          service: "chat-handler",
          timestamp: new Date().toISOString(),
          db_operation: operation,
          retry_reason: retryReason,
          attempt: attemptIndex + 1,
          next_attempt: attemptIndex + 2,
          retry_delay_ms: retryDelayMs,
          ...metadata,
        }),
      );
      await waitForRetryDelay(retryDelayMs);
    }
  }
};

const ACCESS_DENIED_ERROR_CODE = "ACCESS_DENIED";
const CHAT_CANCELED_ERROR_CODE = "CHAT_CANCELED";
const CHAT_UNAUTHORIZED_ERROR_CODE = "CHAT_UNAUTHORIZED";
const MESSAGE_UNAUTHORIZED_ERROR_CODE = "MESSAGE_UNAUTHORIZED";
const MESSAGE_TOO_LARGE_ERROR_CODE = "MESSAGE_TOO_LARGE";

const isChatNotFoundMessageSaveError = (
  operation: string,
  dbErrorData: unknown,
): boolean =>
  operation === "messages.saveMessage" &&
  hasDatabaseErrorCode(dbErrorData, "CHAT_NOT_FOUND");

const isChatCanceledMessageSaveError = (
  operation: string,
  dbErrorData: unknown,
): boolean =>
  operation === "messages.saveMessage" &&
  hasDatabaseErrorCode(dbErrorData, CHAT_CANCELED_ERROR_CODE);

const isChatUnauthorizedError = (dbErrorData: unknown): boolean =>
  hasDatabaseErrorCode(dbErrorData, ACCESS_DENIED_ERROR_CODE) ||
  hasDatabaseErrorCode(dbErrorData, CHAT_UNAUTHORIZED_ERROR_CODE) ||
  hasDatabaseErrorCode(dbErrorData, MESSAGE_UNAUTHORIZED_ERROR_CODE);

const isMessageTooLargeError = (
  operation: string,
  dbErrorData: unknown,
): boolean =>
  operation === "messages.saveMessage" &&
  hasDatabaseErrorCode(dbErrorData, MESSAGE_TOO_LARGE_ERROR_CODE);

const logChatMessagePreparationFailure = (
  event: string,
  level: "warn" | "error",
  fields: Record<string, unknown>,
) => {
  const payload = {
    level,
    event,
    service: "chat-handler",
    timestamp: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === "warn") {
    console.warn(line);
  } else {
    console.error(event, line);
  }
};

const databaseError = (
  operation: string,
  error: unknown,
  metadata: Record<string, unknown> = {},
) => {
  const dbErrorName = error instanceof Error ? error.name : typeof error;
  const { message: dbErrorMessage, upstreamHttpError } =
    getDatabaseErrorDiagnostic(error);
  const dbErrorData = getErrorData(error);
  const isChatNotFound = isChatNotFoundMessageSaveError(operation, dbErrorData);
  const isChatCanceled = isChatCanceledMessageSaveError(operation, dbErrorData);
  const isChatUnauthorized = isChatUnauthorizedError(dbErrorData);
  const isMessageTooLarge = isMessageTooLargeError(operation, dbErrorData);
  const retryReason = getRetryableReasonForDatabaseOperation(operation, error);
  const logLevel =
    isChatNotFound || isChatCanceled || isChatUnauthorized || isMessageTooLarge
      ? "warn"
      : "error";
  const event = isChatNotFound
    ? "database_operation_skipped_chat_not_found"
    : isChatCanceled
      ? "message_save_rejected_chat_canceled"
      : isChatUnauthorized
        ? "chat_access_denied"
        : isMessageTooLarge
          ? "message_save_rejected_too_large"
          : "database_operation_failed";
  const errorCode = isChatNotFound
    ? "not_found:chat"
    : isChatCanceled
      ? "bad_request:chat"
      : isChatUnauthorized
        ? "forbidden:chat"
        : isMessageTooLarge
          ? "bad_request:api"
          : retryReason
            ? "offline:database"
            : "bad_request:database";
  const errorMessage = isChatNotFound
    ? `Chat no longer exists while saving message: ${operation}: ${dbErrorMessage}`
    : isChatCanceled
      ? "This chat was stopped before your message could be saved. Please send it again."
      : isChatUnauthorized
        ? `Chat access denied while executing database operation: ${operation}: ${dbErrorMessage}`
        : isMessageTooLarge
          ? "Your message is too large to save. Please shorten it or attach the content as a file instead."
          : retryReason
            ? `Database temporarily unavailable: ${operation}: ${dbErrorMessage}`
            : `Database operation failed: ${operation}: ${dbErrorMessage}`;
  const diagnosticMetadata: Record<string, unknown> = {
    db_operation: operation,
    db_error_name: dbErrorName,
    db_error_message: dbErrorMessage,
    db_request_id: getConvexRequestIdFromMessage(dbErrorMessage),
    db_error_code: getDatabaseErrorCode(dbErrorData),
    db_cause_error_code: getDatabaseCauseErrorCode(dbErrorData),
    db_failure_stage: getDatabaseFailureStage(dbErrorData),
    db_retry_reason: retryReason,
    db_error_kind: upstreamHttpError ? "convex_upstream_http_error" : undefined,
    db_upstream_status_code: upstreamHttpError?.statusCode,
    db_upstream_ray_id: upstreamHttpError?.rayId,
    ...metadata,
  };

  const logPayload = {
    level: logLevel,
    event,
    service: "chat-handler",
    timestamp: new Date().toISOString(),
    ...diagnosticMetadata,
  };

  const logLine = JSON.stringify(logPayload);
  if (logLevel === "warn") {
    console.warn(logLine);
  } else {
    console.error(event, logLine);
    phLogger.event(event, {
      ...diagnosticMetadata,
      service: "chat-handler",
      level: logLevel,
      userId:
        typeof diagnosticMetadata.user_id === "string"
          ? diagnosticMetadata.user_id
          : undefined,
    });
  }

  return new ChatSDKError(errorCode, errorMessage, diagnosticMetadata);
};

type MessagesPageForBackendResult = {
  page: UIMessage[];
  isDone: boolean;
  continueCursor: string | null;
};

const getMessagesPageForBackendWithRetry = async ({
  chatId,
  userId,
  paginationOpts,
  mode,
  isTemporary,
  regenerate,
  newMessagesCount,
}: {
  chatId: string;
  userId: string;
  paginationOpts: { numItems: number; cursor: string | null };
  mode?: ChatMode;
  isTemporary: boolean;
  regenerate: boolean;
  newMessagesCount: number;
}): Promise<MessagesPageForBackendResult> => {
  const queryArgs = {
    serviceKey,
    chatId,
    userId,
    paginationOpts,
  };

  for (let attemptIndex = 0; ; attemptIndex++) {
    try {
      return await getConvexClient().query(
        api.messages.getMessagesPageForBackend,
        queryArgs,
      );
    } catch (error) {
      const retryReason = getRetryableDatabaseErrorReason(error);
      const retryDelayMs = GET_MESSAGES_PAGE_RETRY_DELAYS_MS[attemptIndex];
      if (!retryReason || retryDelayMs === undefined) {
        throw error;
      }

      console.warn(
        JSON.stringify({
          level: "warn",
          event: "chat_history_fetch_retry_scheduled",
          service: "chat-handler",
          timestamp: new Date().toISOString(),
          db_operation: "messages.getMessagesPageForBackend",
          retry_reason: retryReason,
          attempt: attemptIndex + 1,
          next_attempt: attemptIndex + 2,
          retry_delay_ms: retryDelayMs,
          chat_id: chatId,
          user_id: userId,
          mode,
          is_temporary: isTemporary,
          regenerate,
          new_messages_count: newMessagesCount,
          page_size: paginationOpts.numItems,
          cursor_present: paginationOpts.cursor !== null,
        }),
      );
      await waitForRetryDelay(retryDelayMs);
    }
  }
};

export async function getChatById({ id }: { id: string }) {
  try {
    const queryArgs = {
      serviceKey,
      id,
    };

    for (let attemptIndex = 0; ; attemptIndex++) {
      try {
        return await getConvexClient().query(api.chats.getChatById, queryArgs);
      } catch (error) {
        const retryReason = getRetryableGetChatErrorReason(error);
        const retryDelayMs = GET_CHAT_RETRY_DELAYS_MS[attemptIndex];
        if (!retryReason || retryDelayMs === undefined) {
          throw error;
        }

        console.warn(
          JSON.stringify({
            level: "warn",
            event: "chat_fetch_retry_scheduled",
            service: "chat-handler",
            timestamp: new Date().toISOString(),
            db_operation: "chats.getChatById",
            retry_reason: retryReason,
            attempt: attemptIndex + 1,
            next_attempt: attemptIndex + 2,
            retry_delay_ms: retryDelayMs,
            chat_id: id,
          }),
        );
        await waitForRetryDelay(retryDelayMs);
      }
    }
  } catch (error) {
    throw databaseError("chats.getChatById", error, { chat_id: id });
  }
}

export async function deleteChatForBackend({
  chatId,
  userId,
  expectedTriggerRunId,
  expectedApprovalSessionId,
}: {
  chatId: string;
  userId: string;
  expectedTriggerRunId: string | null;
  expectedApprovalSessionId: string | null;
}) {
  const mutationArgs = {
    serviceKey,
    chatId,
    userId,
    expectedTriggerRunId,
    expectedApprovalSessionId,
  };

  try {
    return await runRetryableChatDeletion({
      operation: "chats.deleteChatForBackend",
      metadata: { chat_id: chatId, user_id: userId },
      mutation: () =>
        getConvexClient().mutation(
          api.chats.deleteChatForBackend,
          mutationArgs,
        ),
    });
  } catch (error) {
    throw databaseError("chats.deleteChatForBackend", error, {
      chat_id: chatId,
      user_id: userId,
    });
  }
}

export async function getActiveTriggerRunsForUser({
  userId,
}: {
  userId: string;
}) {
  try {
    return await getConvexClient().query(
      api.chats.getActiveTriggerRunsForUser,
      {
        serviceKey,
        userId,
      },
    );
  } catch (error) {
    throw databaseError("chats.getActiveTriggerRunsForUser", error, {
      user_id: userId,
    });
  }
}

export async function fenceAndGetActiveAgentResourcesForUser({
  userId,
}: {
  userId: string;
}) {
  try {
    const resourcesByChatId = new Map<string, ActiveAgentResource>();
    let cursor: string | null = null;

    for (let batch = 0; batch < MAX_CHAT_DELETION_FENCE_BATCHES; batch++) {
      const result: ChatDeletionFencePage = await getConvexClient().mutation(
        api.chats.fenceChatsForDeletion,
        {
          serviceKey,
          userId,
          cursor,
        },
      );

      for (const resource of result.resources) {
        resourcesByChatId.set(resource.chatId, resource);
      }

      if (result.isDone) {
        const resources = [...resourcesByChatId.values()];
        return {
          resources: resources.slice(0, MAX_ACTIVE_AGENT_RESOURCES_TO_RETURN),
          hasMore: resources.length > MAX_ACTIVE_AGENT_RESOURCES_TO_RETURN,
        };
      }

      cursor = result.continueCursor;
    }

    throw new Error(
      "Chat deletion fencing is taking longer than expected. Please retry deletion.",
    );
  } catch (error) {
    throw databaseError("chats.fenceAndGetActiveAgentResourcesForUser", error, {
      user_id: userId,
    });
  }
}

export async function deleteAllChatsForBackend({ userId }: { userId: string }) {
  try {
    await runRetryableChatDeletion({
      operation: "chats.deleteAllChatsForBackend",
      metadata: { user_id: userId },
      mutation: () =>
        getConvexClient().mutation(api.chats.deleteAllChatsForBackend, {
          serviceKey,
          userId,
        }),
    });
  } catch (error) {
    throw databaseError("chats.deleteAllChatsForBackend", error, {
      user_id: userId,
    });
  }
}

export async function saveChat({
  id,
  userId,
  title,
}: {
  id: string;
  userId: string;
  title: string;
}) {
  const mutationArgs = {
    serviceKey,
    id,
    userId,
    title,
  };

  try {
    for (let attemptIndex = 0; ; attemptIndex++) {
      try {
        return await getConvexClient().mutation(
          api.chats.saveChat,
          mutationArgs,
        );
      } catch (error) {
        const retryReason = getRetryableSaveChatErrorReason(error);
        const retryDelayMs = SAVE_CHAT_RETRY_DELAYS_MS[attemptIndex];
        if (!retryReason || retryDelayMs === undefined) {
          throw error;
        }

        console.warn(
          JSON.stringify({
            level: "warn",
            event: "chat_save_retry_scheduled",
            service: "chat-handler",
            timestamp: new Date().toISOString(),
            db_operation: "chats.saveChat",
            retry_reason: retryReason,
            attempt: attemptIndex + 1,
            next_attempt: attemptIndex + 2,
            retry_delay_ms: retryDelayMs,
            chat_id: id,
            user_id: userId,
            title_length: title.length,
          }),
        );
        await waitForRetryDelay(retryDelayMs);
      }
    }
  } catch (error) {
    throw databaseError("chats.saveChat", error, {
      chat_id: id,
      user_id: userId,
      title_length: title.length,
    });
  }
}
export async function saveMessage({
  chatId,
  userId,
  message,
  extraFileIds,
  model,
  mode,
  generationStartedAt,
  generationTimeMs,
  finishReason,
  usage,
  updateOnly,
  isHidden,
  wasAborted,
  wasPreemptiveTimeout,
}: {
  chatId: string;
  userId: string;
  message: {
    id: string;
    role: "user" | "assistant" | "system";
    parts: UIMessagePart<any, any>[];
  };
  extraFileIds?: Array<Id<"files">>;
  model?: string;
  mode?: ChatMode;
  generationStartedAt?: number;
  generationTimeMs?: number;
  finishReason?: string;
  usage?: Record<string, unknown>;
  updateOnly?: boolean;
  isHidden?: boolean;
  wasAborted?: boolean;
  wasPreemptiveTimeout?: boolean;
}) {
  let fixedParts = message.parts;
  let partsForSave = message.parts;
  let persistenceDiagnostics = getMessagePersistenceDiagnostics(partsForSave);

  try {
    // Fix incomplete tool invocations for assistant messages (from interrupted streams)
    fixedParts =
      message.role === "assistant"
        ? fixIncompleteMessageParts(message.parts, {
            logContext: {
              service: "chat-handler",
              source: "save_message",
              chatId,
              userId,
              messageId: message.id,
              mode,
              finishReason,
              updateOnly,
            },
          })
        : message.parts;
    fixedParts =
      message.role === "assistant"
        ? stripOpenRouterReasoningMetadataFromParts(fixedParts)
        : fixedParts;
    const convexSafeParts = sanitizeForConvexValue(fixedParts) as UIMessagePart<
      any,
      any
    >[];
    const storageSafeMessage =
      message.role === "assistant"
        ? compactMessageForStorage({ ...message, parts: convexSafeParts })
        : null;
    const storageSafeParts =
      storageSafeMessage?.message.parts ?? convexSafeParts;
    if (storageSafeMessage?.compacted) {
      console.info("[db] compacted assistant message before save", {
        chatId,
        messageId: message.id,
        beforeSizeBytes: storageSafeMessage.beforeSizeBytes,
        afterSizeBytes: storageSafeMessage.afterSizeBytes,
        prunedCount: storageSafeMessage.prunedCount,
        strippedUiOnlyFields: storageSafeMessage.strippedUiOnlyFields,
      });
    }

    partsForSave = sanitizeForConvexValue(storageSafeParts) as UIMessagePart<
      any,
      any
    >[];
    persistenceDiagnostics = getMessagePersistenceDiagnostics(partsForSave);
    if (
      message.role === "assistant" &&
      persistenceDiagnostics.parts_size_bytes > LARGE_MESSAGE_SAVE_WARNING_BYTES
    ) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "large_message_save_attempt",
          service: "chat-handler",
          timestamp: new Date().toISOString(),
          chat_id: chatId,
          user_id: userId,
          message_id: message.id,
          mode,
          model,
          finish_reason: finishReason,
          ...persistenceDiagnostics,
        }),
      );
    }

    // Extract file IDs from file parts
    const fileIds = extractFileIdsFromParts(partsForSave);
    const mergedFileIds = [
      ...fileIds,
      ...((extraFileIds || []).filter(Boolean) as string[]),
    ];
    const usageForSave = sanitizeForConvexValue(usage) as
      Record<string, unknown> | undefined;

    const mutationArgs = {
      serviceKey,
      id: message.id,
      chatId,
      userId,
      role: message.role,
      parts: partsForSave,
      fileIds: mergedFileIds.length > 0 ? (mergedFileIds as any) : undefined,
      model,
      mode,
      generationStartedAt,
      generationTimeMs,
      finishReason,
      usage: usageForSave,
      updateOnly,
      isHidden,
    };

    for (let attemptIndex = 0; ; attemptIndex++) {
      try {
        return await getConvexClient().mutation(
          api.messages.saveMessage,
          mutationArgs,
        );
      } catch (error) {
        const retryReason = getRetryableSaveMessageErrorReason(error);
        const retryDelayMs = SAVE_MESSAGE_RETRY_DELAYS_MS[attemptIndex];
        if (!retryReason || retryDelayMs === undefined) {
          throw error;
        }

        console.warn(
          JSON.stringify({
            level: "warn",
            event: "message_save_retry_scheduled",
            service: "chat-handler",
            timestamp: new Date().toISOString(),
            db_operation: "messages.saveMessage",
            retry_reason: retryReason,
            attempt: attemptIndex + 1,
            next_attempt: attemptIndex + 2,
            retry_delay_ms: retryDelayMs,
            chat_id: chatId,
            user_id: userId,
            message_id: message.id,
            message_role: message.role,
            mode,
            model,
            finish_reason: finishReason,
            update_only: updateOnly === true,
            hidden: isHidden === true,
            ...persistenceDiagnostics,
          }),
        );
        await waitForRetryDelay(retryDelayMs);
      }
    }
  } catch (error) {
    throw databaseError("messages.saveMessage", error, {
      chat_id: chatId,
      user_id: userId,
      message_id: message.id,
      message_role: message.role,
      mode,
      model,
      finish_reason: finishReason,
      update_only: updateOnly === true,
      hidden: isHidden === true,
      was_aborted: wasAborted,
      was_preemptive_timeout: wasPreemptiveTimeout,
      extra_file_count: extraFileIds?.length ?? 0,
      usage_keys: usage ? Object.keys(usage).sort() : undefined,
      ...persistenceDiagnostics,
    });
  }
}

export async function handleInitialChatAndUserMessage({
  chatId,
  userId,
  messages,
  regenerate,
  chat,
  isHidden,
}: {
  chatId: string;
  userId: string;
  messages: { id: string; parts: UIMessagePart<any, any>[] }[];
  regenerate?: boolean;
  chat: any; // Chat data from getMessagesByChatId
  isHidden?: boolean;
}) {
  if (!chat) {
    // Save new chat and get the document _id
    let title = "New Chat";

    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (
        lastMessage?.parts &&
        Array.isArray(lastMessage.parts) &&
        lastMessage.parts.length > 0
      ) {
        const firstPart = lastMessage.parts[0];
        if (firstPart?.type === "text" && firstPart.text) {
          title = firstPart.text;
        }
      }
    }

    // Ensure title is a string and truncate safely
    title = (title ?? "New Chat").substring(0, 100);

    await saveChat({
      id: chatId,
      userId,
      title,
    });
  } else {
    // Check if user owns the chat
    if (chat.user_id !== userId) {
      throw new ChatSDKError(
        "forbidden:chat",
        "You don't have permission to access this chat",
      );
    }
  }

  // Only save user message if this is not a regeneration
  if (!regenerate && Array.isArray(messages) && messages.length > 0) {
    await saveMessage({
      chatId,
      userId,
      message: {
        id: messages[messages.length - 1].id,
        role: "user",
        parts: messages[messages.length - 1].parts,
      },
      isHidden,
    });
  }
}

export async function updateChat({
  chatId,
  title,
  finishReason,
  todos,
  defaultModelSlug,
  sandboxType,
  selectedModel,
}: {
  chatId: string;
  title?: string;
  finishReason?: string;
  todos?: Array<{
    id: string;
    content: string;
    status: "pending" | "in_progress" | "completed" | "cancelled";
    sourceMessageId?: string;
  }>;
  defaultModelSlug?: "ask" | "agent";
  sandboxType?: string;
  selectedModel?: string;
}) {
  const mutationArgs = {
    serviceKey,
    chatId,
    title,
    finishReason,
    todos,
    defaultModelSlug,
    sandboxType,
    selectedModel,
  };

  for (let attemptIndex = 0; ; attemptIndex++) {
    try {
      return await getConvexClient().mutation(
        api.chats.updateChat,
        mutationArgs,
      );
    } catch (error) {
      const retryReason = getRetryableDatabaseErrorReason(error);
      const retryDelayMs = UPDATE_CHAT_RETRY_DELAYS_MS[attemptIndex];
      if (!retryReason || retryDelayMs === undefined) {
        throw databaseError("chats.updateChat", error, {
          chat_id: chatId,
        });
      }

      console.warn(
        JSON.stringify({
          level: "warn",
          event: "chat_update_retry_scheduled",
          service: "chat-handler",
          environment:
            process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
          timestamp: new Date().toISOString(),
          db_operation: "chats.updateChat",
          retry_reason: retryReason,
          attempt: attemptIndex + 1,
          next_attempt: attemptIndex + 2,
          retry_delay_ms: retryDelayMs,
          chat_id: chatId,
        }),
      );
      await waitForRetryDelay(retryDelayMs);
    }
  }
}

export async function getMessagesByChatId({
  chatId,
  userId,
  newMessages,
  regenerate,
  subscription,
  isTemporary,
  mode,
  useClientMessagesForRegenerate,
}: {
  chatId: string;
  userId: string;
  subscription: SubscriptionTier;
  newMessages: UIMessage[];
  regenerate?: boolean;
  isTemporary?: boolean;
  mode?: import("@/types").ChatMode;
  useClientMessagesForRegenerate?: boolean;
}) {
  // For temporary chats, skip database operations
  let chat = undefined;
  let isNewChat = true;
  let existingMessages: UIMessage[] = [];

  if (!isTemporary) {
    // Check if chat exists first to avoid unnecessary Convex query
    chat = await getChatById({ id: chatId });
    isNewChat = !chat;

    const shouldUseClientMessagesForRegenerate =
      !!regenerate &&
      !!useClientMessagesForRegenerate &&
      Array.isArray(newMessages) &&
      newMessages.length > 0 &&
      hasRestageableLocalDesktopAttachments(newMessages);

    if (!isNewChat && shouldUseClientMessagesForRegenerate) {
      // Persisted local desktop attachments are saved without source paths.
      // When the current client still has those paths, use that trimmed
      // history for this regenerate so the files can be staged again.
      existingMessages = newMessages;
    }

    // Only fetch existing messages if chat exists
    if (!isNewChat && !shouldUseClientMessagesForRegenerate) {
      try {
        // Fetch latest summary only if chat has a summary ID
        const latestSummary =
          !regenerate && chat?.latest_summary_id
            ? await getLatestSummary({ chatId })
            : null;

        // Adaptive paginated backfill: fetch pages until token budget is hit or cap reached
        const PAGE_SIZE = 24;
        const MAX_PAGES = 4;

        let cursor: string | null = null;
        let pagesFetched = 0;
        let fetchedDesc: UIMessage[] = [];
        let truncatedFromLoop: UIMessage[] | null = null;
        let fileTokensFromLoop: Record<Id<"files">, number> = {};
        const skipFileTokens = mode === "agent";

        while (pagesFetched < MAX_PAGES) {
          const pageResult: {
            page: UIMessage[];
            isDone: boolean;
            continueCursor: string | null;
          } = await getMessagesPageForBackendWithRetry({
            chatId,
            userId,
            paginationOpts: { numItems: PAGE_SIZE, cursor },
            mode,
            isTemporary: !!isTemporary,
            regenerate: !!regenerate,
            newMessagesCount: newMessages.length,
          });
          const { page, isDone, continueCursor: nextCursor } = pageResult;

          fetchedDesc = fetchedDesc.concat(page);
          pagesFetched++;

          const existingChrono = [...fetchedDesc].reverse();
          const candidate =
            regenerate && !isTemporary
              ? existingChrono
              : [...existingChrono, ...newMessages];

          // Incrementally fetch file tokens only for new file IDs not yet cached
          if (!skipFileTokens) {
            const allFileIds = extractAllFileIdsFromMessages(candidate);
            const uncachedIds = allFileIds.filter(
              (id) => !(id in fileTokensFromLoop),
            );
            if (uncachedIds.length > 0) {
              const newTokens = await getFileTokensByIds(uncachedIds, userId);
              Object.assign(fileTokensFromLoop, newTokens);
            }
          }

          const maxTokens = getMaxTokensForSubscription(subscription, {
            mode,
          });
          const truncatedMessages = truncateMessagesToTokenLimit(
            candidate,
            fileTokensFromLoop,
            maxTokens,
          );

          const hitBudget = truncatedMessages.length < candidate.length;
          const reachedLimit = isDone || pagesFetched >= MAX_PAGES;

          if (hitBudget || reachedLimit) {
            truncatedFromLoop = truncatedMessages;
            break;
          }

          cursor = nextCursor || null;
          if (!cursor) {
            // No more pages
            truncatedFromLoop = truncatedMessages;
            break;
          }
        }

        // In regenerate mode the conversation must end with a user message.
        // The client should have deleted the last assistant message before
        // calling regenerate, but if that hasn't propagated yet we must
        // strip it here so all return paths below (summary early-return,
        // no-summary early-return, and the fallthrough) stay consistent.
        if (regenerate && !isTemporary && truncatedFromLoop) {
          while (
            truncatedFromLoop.length > 0 &&
            truncatedFromLoop[truncatedFromLoop.length - 1].role === "assistant"
          ) {
            truncatedFromLoop = truncatedFromLoop.slice(0, -1);
          }
        }

        // If loop didn't run or didn't set, fall back to whatever we accumulated
        if (!fetchedDesc.length && !truncatedFromLoop) {
          existingMessages = [];
        } else if (!truncatedFromLoop) {
          // Use all fetched messages chronologically as existing
          existingMessages = [...fetchedDesc].reverse();
        } else {
          // Apply summary if it exists, except during regeneration where the
          // deleted assistant response must not leak back into the new run.
          if (latestSummary && !regenerate) {
            const summaryUpToId = latestSummary.summary_up_to_message_id;
            const availableChrono = [...fetchedDesc]
              .reverse()
              .concat(newMessages);

            // Create summary message, prepending resume preamble for agent modes
            const summaryPrefix =
              mode && isAgentMode(mode) ? AGENT_RESUME_PREAMBLE : "";
            const summaryMessage: UIMessage = {
              id: uuidv4(),
              role: "user",
              parts: [
                {
                  type: "text",
                  text: `${summaryPrefix}<context_summary>\n${latestSummary.summary_text}\n</context_summary>`,
                },
              ],
            };

            // Re-truncate real messages to leave room for the summary message
            const maxTokens = getMaxTokensForSubscription(subscription, {
              mode,
            });
            const summaryTokens = countMessagesTokens(
              [summaryMessage],
              fileTokensFromLoop,
            );
            const budgetForMessages = maxTokens - summaryTokens;
            const retainedTail = latestSummary.retained_tail as
              RetainedTailMetadata | undefined;
            let truncatedAfterCutoff: UIMessage[] = [];

            if (budgetForMessages > 0 && retainedTail) {
              truncatedAfterCutoff = projectRetainedTailFromMessages(
                availableChrono,
                retainedTail,
                {
                  budgetTokens: budgetForMessages,
                  fileTokens: fileTokensFromLoop,
                },
              );

              if (truncatedAfterCutoff.length === 0) {
                const cutoffIndex = availableChrono.findIndex(
                  (m) => m.id === summaryUpToId,
                );
                const messagesAfterCutoff =
                  cutoffIndex >= 0
                    ? availableChrono.slice(cutoffIndex + 1)
                    : availableChrono;
                truncatedAfterCutoff = projectMessagesToTokenBudget(
                  messagesAfterCutoff,
                  {
                    budgetTokens: budgetForMessages,
                    fileTokens: fileTokensFromLoop,
                  },
                );
              }
            } else if (budgetForMessages > 0) {
              // Legacy summaries only have a whole-message cutoff.
              const cutoffIndex = truncatedFromLoop.findIndex(
                (m) => m.id === summaryUpToId,
              );
              const messagesAfterCutoff =
                cutoffIndex >= 0
                  ? truncatedFromLoop.slice(cutoffIndex + 1)
                  : truncatedFromLoop;
              truncatedAfterCutoff = truncateMessagesToTokenLimit(
                messagesAfterCutoff,
                fileTokensFromLoop,
                budgetForMessages,
              );
            }

            const truncatedWithSummary: UIMessage[] = [
              summaryMessage,
              ...truncatedAfterCutoff,
            ];

            return {
              truncatedMessages: truncatedWithSummary,
              chat,
              isNewChat,
              fileTokens: fileTokensFromLoop,
            };
          }

          // No summary injection (ask mode or no summary), return as normal
          return {
            truncatedMessages: truncatedFromLoop,
            chat,
            isNewChat,
            fileTokens: fileTokensFromLoop,
          };
        }
      } catch (error) {
        logChatMessagePreparationFailure("chat_history_fetch_failed", "warn", {
          chat_id: chatId,
          user_id: userId,
          mode,
          is_temporary: !!isTemporary,
          regenerate: !!regenerate,
          new_messages_count: newMessages.length,
          error_name: error instanceof Error ? error.name : typeof error,
          error_message: truncateDiagnosticString(stringifyError(error)),
          db_retry_reason: getRetryableDatabaseErrorReason(error),
          db_error_data: getErrorData(error),
        });

        if (newMessages.length === 0) {
          throw databaseError("messages.getMessagesPageForBackend", error, {
            chat_id: chatId,
            user_id: userId,
            mode,
            is_temporary: !!isTemporary,
            regenerate: !!regenerate,
            new_messages_count: newMessages.length,
          });
        }
      }
    }
  }

  // Handle message merging based on regeneration flag
  let allMessages: UIMessage[];

  if (regenerate && !isTemporary) {
    // Don't append new messages — use existing history up to the last user message
    allMessages = existingMessages;
    // Defensively strip trailing assistant messages.
    // The client should have deleted the last assistant message before
    // calling regenerate, but if that hasn't propagated yet we must
    // ensure the conversation ends with a user message.
    while (
      allMessages.length > 0 &&
      allMessages[allMessages.length - 1].role === "assistant"
    ) {
      allMessages = allMessages.slice(0, -1);
    }
  } else {
    // For normal chat, merge existing messages with the new user message
    allMessages = [...existingMessages, ...newMessages];
  }

  const truncateResult = await truncateMessagesWithFileTokens(
    allMessages,
    subscription,
    mode === "agent", // Skip file tokens for agent mode (files go to sandbox)
    mode,
    userId,
  );
  const truncatedMessages = truncateResult.messages;
  const fileTokens = truncateResult.fileTokens;

  if (!truncatedMessages || truncatedMessages.length === 0) {
    let emptyPromptMetadata: Record<string, unknown> | undefined;
    try {
      const fileIds = extractAllFileIdsFromMessages(allMessages);
      const fileTokens = await getFileTokensByIds(fileIds as any, userId);
      const maxTokens = getMaxTokensForSubscription(subscription, {
        mode,
      });
      const totalTokensBefore = countMessagesTokens(allMessages, fileTokens);
      const largestFileToken = Object.values(fileTokens).length
        ? Math.max(...Object.values(fileTokens))
        : 0;
      emptyPromptMetadata = {
        chat_id: chatId,
        user_id: userId,
        is_temporary: !!isTemporary,
        regenerate: !!regenerate,
        subscription,
        mode,
        existing_messages_count: existingMessages.length,
        new_messages_count: newMessages.length,
        all_messages_count: allMessages.length,
        total_tokens_before: totalTokensBefore,
        max_tokens: maxTokens,
        file_ids_count: fileIds.length,
        file_tokens_sample: Object.entries(fileTokens)
          .slice(0, 5)
          .map(([k, v]) => ({ fileId: k, tokens: v })),
        largest_file_token: largestFileToken,
      };
      logChatMessagePreparationFailure(
        allMessages.length === 0
          ? "chat_prompt_empty"
          : "chat_truncation_dropped_all_messages",
        allMessages.length === 0 ? "warn" : "error",
        emptyPromptMetadata,
      );
    } catch {}

    if (allMessages.length === 0) {
      throw new ChatSDKError(
        "bad_request:api",
        "No message content was found for this request. Please send a new message and try again.",
        {
          empty_prompt: true,
          ...emptyPromptMetadata,
        },
      );
    }

    throw new ChatSDKError(
      "bad_request:api",
      "Your input (including any attached files) is too large to process. Please remove some attachments or shorten your message and try again.",
      {
        truncation_dropped_all_messages: true,
        ...emptyPromptMetadata,
      },
    );
  }

  return { truncatedMessages, chat, isNewChat, fileTokens };
}

export async function getUserCustomization({ userId }: { userId: string }) {
  try {
    const userCustomization = await getConvexClient().query(
      api.userCustomization.getUserCustomizationForBackend,
      {
        serviceKey,
        userId,
      },
    );
    return userCustomization;
  } catch (error) {
    // If no customization found or error, return null
    return null;
  }
}

export async function setActiveTriggerRun({
  chatId,
  triggerRunId,
  approvalSessionId,
  expectedRunId,
  expectedApprovalSessionId,
  clearApprovalPending,
}: {
  chatId: string;
  triggerRunId: string | null;
  approvalSessionId?: string | null;
  expectedRunId?: string;
  expectedApprovalSessionId?: string;
  clearApprovalPending?: boolean;
}) {
  try {
    return await getConvexClient().mutation(api.chats.setActiveTriggerRun, {
      serviceKey,
      chatId,
      triggerRunId,
      ...(approvalSessionId !== undefined ? { approvalSessionId } : {}),
      ...(expectedRunId !== undefined ? { expectedRunId } : {}),
      ...(expectedApprovalSessionId !== undefined
        ? { expectedApprovalSessionId }
        : {}),
      ...(clearApprovalPending !== undefined ? { clearApprovalPending } : {}),
    });
  } catch (error) {
    throw databaseError("chats.setActiveTriggerRun", error, {
      chat_id: chatId,
      trigger_run_id: triggerRunId,
      expected_run_id: expectedRunId,
    });
  }
}

export async function setActiveAgentApprovalPending({
  chatId,
  pending,
  request,
  expectedRunId,
  expectedApprovalSessionId,
}: {
  chatId: string;
  pending: boolean;
  request?: AgentToolApprovalPendingRequest;
  expectedRunId?: string;
  expectedApprovalSessionId?: string;
}) {
  try {
    await getConvexClient().mutation(api.chats.setActiveAgentApprovalPending, {
      serviceKey,
      chatId,
      pending,
      ...(request !== undefined ? { request } : {}),
      ...(expectedRunId !== undefined ? { expectedRunId } : {}),
      ...(expectedApprovalSessionId !== undefined
        ? { expectedApprovalSessionId }
        : {}),
    });
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to set active agent approval state",
    );
  }
}

export async function persistAgentApprovalGrant({
  chatId,
  userId,
  grant,
}: {
  chatId: string;
  userId: string;
  grant: PersistedAgentApprovalTargetGrant;
}) {
  await getConvexClient().mutation(api.chats.persistAgentApprovalGrant, {
    serviceKey,
    chatId,
    userId,
    grant,
  });
}

export async function getActiveTriggerRun({ chatId }: { chatId: string }) {
  try {
    return await getConvexClient().query(api.chats.getActiveTriggerRun, {
      serviceKey,
      chatId,
    });
  } catch (error) {
    return null;
  }
}

export async function startStream({
  chatId,
  streamId,
}: {
  chatId: string;
  streamId: string;
}) {
  try {
    await getConvexClient().mutation(api.chatStreams.startStream, {
      serviceKey,
      chatId,
      streamId,
    });
    return;
  } catch (error) {
    throw new ChatSDKError("bad_request:database", "Failed to start stream");
  }
}

export async function prepareForNewStream({ chatId }: { chatId: string }) {
  try {
    await getConvexClient().mutation(api.chatStreams.prepareForNewStream, {
      serviceKey,
      chatId,
    });
    return;
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to prepare for new stream",
    );
  }
}

export async function getCancellationStatus({ chatId }: { chatId: string }) {
  try {
    const status = await getConvexClient().query(
      api.chatStreams.getCancellationStatus,
      {
        serviceKey,
        chatId,
      },
    );
    return status;
  } catch (error) {
    // Silently return null on error for cancellation checks
    return null;
  }
}

// Temporary chat stream coordination
export async function startTempStream({
  chatId,
  userId,
}: {
  chatId: string;
  userId: string;
}) {
  try {
    await getConvexClient().mutation(api.tempStreams.startTempStream, {
      serviceKey,
      chatId,
      userId,
    });
  } catch (error) {
    // Do not throw; temp coordination best-effort
  }
}

export async function getTempCancellationStatus({
  chatId,
}: {
  chatId: string;
}) {
  try {
    return await getConvexClient().query(
      api.tempStreams.getTempCancellationStatus,
      {
        serviceKey,
        chatId,
      },
    );
  } catch (error) {
    return null;
  }
}

export async function deleteTempStreamForBackend({
  chatId,
}: {
  chatId: string;
}) {
  try {
    await getConvexClient().mutation(
      api.tempStreams.deleteTempStreamForBackend,
      {
        serviceKey,
        chatId,
      },
    );
  } catch (error) {
    // Best-effort cleanup
  }
}

export async function saveChatSummary({
  chatId,
  summaryText,
  summaryUpToMessageId,
  metadata,
}: {
  chatId: string;
  summaryText: string;
  summaryUpToMessageId: string;
  metadata?: {
    reason?: SummaryReason;
    promptVersion?: string;
    model?: string;
    status?: string;
    error?: string;
    transcriptPath?: string;
    retainedTail?: RetainedTailMetadata;
  };
}) {
  try {
    const compactedMetadata = metadata
      ? Object.fromEntries(
          Object.entries(metadata).filter(([, value]) => value !== undefined),
        )
      : undefined;

    await getConvexClient().mutation(api.chats.saveLatestSummary, {
      serviceKey,
      chatId,
      summaryText,
      summaryUpToMessageId,
      ...(compactedMetadata ? { metadata: compactedMetadata } : {}),
    });

    return;
  } catch (error) {
    console.error("[DB Actions] Failed to save chat summary", {
      chatId,
      summaryUpToMessageId,
      summaryTextLength: summaryText.length,
      summaryTextSizeKB: Math.round(
        Buffer.byteLength(summaryText, "utf-8") / 1024,
      ),
      error: error instanceof Error ? error.message : String(error),
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to save chat summary",
    );
  }
}

export async function getLatestSummary({ chatId }: { chatId: string }) {
  try {
    const summary = await getConvexClient().query(
      api.chats.getLatestSummaryForBackend,
      {
        serviceKey,
        chatId,
      },
    );
    return summary;
  } catch (error) {
    console.error("[DB Actions] Failed to get latest summary:", error);
    return null;
  }
}

// ============================================================================
// Notes Actions
// ============================================================================

export async function createNote({
  userId,
  title,
  content,
  category,
  tags,
}: {
  userId: string;
  title: string;
  content: string;
  category?: NoteCategory;
  tags?: string[];
}) {
  try {
    const result = await getConvexClient().mutation(
      api.notes.createNoteForBackend,
      {
        serviceKey,
        userId,
        title,
        content,
        category,
        tags,
      },
    );
    return result;
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to create note",
    );
  }
}

export async function listNotes({
  userId,
  category,
  tags,
  search,
}: {
  userId: string;
  category?: NoteCategory;
  tags?: string[];
  search?: string;
}) {
  try {
    const result = await getConvexClient().query(
      api.notes.listNotesForBackend,
      {
        serviceKey,
        userId,
        category,
        tags,
        search,
      },
    );
    return result;
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to list notes",
    );
  }
}

export async function updateNote({
  userId,
  noteId,
  title,
  content,
  tags,
}: {
  userId: string;
  noteId: string;
  title?: string;
  content?: string;
  tags?: string[];
}) {
  try {
    const result = await getConvexClient().mutation(
      api.notes.updateNoteForBackend,
      {
        serviceKey,
        userId,
        noteId,
        title,
        content,
        tags,
      },
    );
    return result;
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to update note",
    );
  }
}

export async function deleteNote({
  userId,
  noteId,
}: {
  userId: string;
  noteId: string;
}) {
  try {
    const result = await getConvexClient().mutation(
      api.notes.deleteNoteForBackend,
      {
        serviceKey,
        userId,
        noteId,
      },
    );
    return result;
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to delete note",
    );
  }
}

export async function getNotes({
  userId,
  subscription,
}: {
  userId: string;
  subscription: SubscriptionTier;
}) {
  try {
    const notes = await getConvexClient().query(api.notes.getNotesForBackend, {
      serviceKey,
      userId,
      subscription,
    });
    return notes;
  } catch (error) {
    // If no notes found or error, return empty array
    return [];
  }
}

export async function logUsageRecord({
  usageSettlementId,
  userId,
  organizationId,
  chatId,
  endpoint,
  mode,
  subscription,
  model,
  type,
  includedCostDollars,
  extraUsageCostDollars,
  uncoveredCostDollars,
  includedPointsDeducted,
  extraUsagePointsDeducted,
  uncoveredPoints,
  usageDeductionFailed,
  usageDeductionFailureReason,
  inputTokens,
  outputTokens,
  totalTokens,
  cacheReadTokens,
  cacheWriteTokens,
  costDollars,
  modelCostDollars,
  nonModelCostDollars,
  costSource,
}: {
  usageSettlementId?: string;
  userId: string;
  organizationId?: string;
  chatId?: string;
  endpoint?: ChatApiEndpoint;
  mode?: ChatMode;
  subscription?: SubscriptionTier;
  model: string;
  type: "included" | "extra" | "mixed";
  includedCostDollars?: number;
  extraUsageCostDollars?: number;
  uncoveredCostDollars?: number;
  includedPointsDeducted?: number;
  extraUsagePointsDeducted?: number;
  uncoveredPoints?: number;
  usageDeductionFailed?: boolean;
  usageDeductionFailureReason?: UsageDeductionFailureReason;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costDollars: number;
  modelCostDollars?: number;
  nonModelCostDollars?: number;
  costSource?: "provider" | "token_estimate" | "raw_token_estimate";
}) {
  try {
    await getConvexClient().mutation(api.usageLogs.logUsage, {
      serviceKey,
      usage_settlement_id: usageSettlementId,
      user_id: userId,
      organization_id: organizationId,
      chat_id: chatId,
      endpoint,
      mode,
      subscription,
      model,
      type,
      included_cost_dollars: includedCostDollars,
      extra_usage_cost_dollars: extraUsageCostDollars,
      uncovered_cost_dollars: uncoveredCostDollars,
      included_points_deducted: includedPointsDeducted,
      extra_usage_points_deducted: extraUsagePointsDeducted,
      uncovered_points: uncoveredPoints,
      usage_deduction_failed: usageDeductionFailed,
      usage_deduction_failure_reason: usageDeductionFailureReason,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      total_tokens: totalTokens,
      cost_dollars: costDollars,
      model_cost_dollars: modelCostDollars,
      non_model_cost_dollars: nonModelCostDollars,
      cost_source: costSource,
    });
  } catch (error) {
    console.error("Failed to log usage record:", {
      error,
      usage_settlement_id: usageSettlementId,
      userId,
      organizationId,
      chatId,
      endpoint,
      mode,
      subscription,
      model,
      type,
      costDollars,
      modelCostDollars,
      nonModelCostDollars,
      costSource,
      inputTokens,
      outputTokens,
    });
  }
}
