import { tags, metadata, logger as triggerLogger } from "@trigger.dev/sdk";
import type { AgentStreamState } from "@/lib/api/agent-stream-runner";
import { isProviderApiError } from "@/lib/api/chat-stream-helpers";
import { ChatSDKError } from "@/lib/errors";
import {
  extractErrorDetails,
  getProviderErrorCategory,
} from "@/lib/utils/error-utils";

const MAX_TRIGGER_ERROR_MESSAGE_LENGTH = 500;

const truncateForTriggerMetadata = (value: string) =>
  value.length > MAX_TRIGGER_ERROR_MESSAGE_LENGTH
    ? `${value.slice(0, MAX_TRIGGER_ERROR_MESSAGE_LENGTH)}...`
    : value;

const sanitizeTriggerTagValue = (value: string) =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);

const getStringMetadata = (
  metadata: Record<string, unknown> | undefined,
  key: string,
) => {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
};

const getNumberMetadata = (
  metadata: Record<string, unknown> | undefined,
  key: string,
) => {
  const value = metadata?.[key];
  return typeof value === "number" ? value : undefined;
};

const OPERATIONAL_RATE_LIMIT_CAUSE_PATTERNS = [
  /rate limiting service .*not configured/i,
  /rate limiting service unavailable/i,
  /extra usage billing is temporarily unavailable/i,
];

type TriggerChatErrorSummary = {
  category: string;
  code?: string;
  name: string;
  message: string;
  cause?: string;
  loginRequired: boolean;
  statusCode?: number;
  dbOperation?: string;
  dbErrorName?: string;
  dbErrorMessage?: string;
  partsSizeKb?: number;
  partCount?: number;
  largestPartType?: string;
  largestPartSizeKb?: number;
  toolPartCount?: number;
  dataPartCount?: number;
  reasoningChars?: number;
  emptyPrompt?: boolean;
  truncationDroppedAllMessages?: boolean;
  existingMessagesCount?: number;
  newMessagesCount?: number;
  allMessagesCount?: number;
  totalTokensBefore?: number;
  maxTokens?: number;
  fileIdsCount?: number;
  largestFileToken?: number;
};

export const isHandledUserRateLimitError = (
  error: unknown,
): error is ChatSDKError => {
  if (!(error instanceof ChatSDKError)) return false;
  if (error.type !== "rate_limit" || error.surface !== "chat") return false;

  const cause = typeof error.cause === "string" ? error.cause : error.message;
  return !OPERATIONAL_RATE_LIMIT_CAUSE_PATTERNS.some((pattern) =>
    pattern.test(cause),
  );
};

export const isChatNotFoundError = (error: ChatSDKError): boolean => {
  if (error.type === "not_found" && error.surface === "chat") return true;
  return (
    getStringMetadata(error.metadata, "db_error_code") === "CHAT_NOT_FOUND"
  );
};

const classifyProviderDashboardCategory = (
  error: unknown,
  details: Record<string, unknown>,
): string => {
  const category = getProviderErrorCategory(details);
  if (category === "stream_terminated") return "provider_stream_terminated";
  if (category === "timeout") return "provider_timeout";
  if (category !== "unknown" || isProviderApiError(error)) {
    return "provider_error";
  }
  return "unexpected_error";
};

const classifyTriggerChatError = (error: unknown): TriggerChatErrorSummary => {
  const details = extractErrorDetails(error);
  const errorMessage = truncateForTriggerMetadata(
    typeof details.errorMessage === "string"
      ? details.errorMessage
      : "Unknown error occurred",
  );

  if (error instanceof ChatSDKError) {
    const code = `${error.type}:${error.surface}`;
    const cause =
      typeof error.cause === "string"
        ? truncateForTriggerMetadata(error.cause)
        : undefined;
    const errorMetadata = error.metadata;
    return {
      category:
        error.type === "unauthorized"
          ? "login_required"
          : isChatNotFoundError(error)
            ? "chat_not_found"
            : errorMetadata?.empty_prompt === true
              ? "empty_prompt"
              : errorMetadata?.truncation_dropped_all_messages === true
                ? "input_too_large"
                : "chat_error",
      code,
      name: "ChatSDKError",
      message: errorMessage,
      cause,
      loginRequired: error.type === "unauthorized",
      statusCode: error.statusCode,
      dbOperation: getStringMetadata(errorMetadata, "db_operation"),
      dbErrorName: getStringMetadata(errorMetadata, "db_error_name"),
      dbErrorMessage: getStringMetadata(errorMetadata, "db_error_message"),
      partsSizeKb: getNumberMetadata(errorMetadata, "parts_size_kb"),
      partCount: getNumberMetadata(errorMetadata, "part_count"),
      largestPartType: getStringMetadata(errorMetadata, "largest_part_type"),
      largestPartSizeKb: getNumberMetadata(
        errorMetadata,
        "largest_part_size_kb",
      ),
      toolPartCount: getNumberMetadata(errorMetadata, "tool_part_count"),
      dataPartCount: getNumberMetadata(errorMetadata, "data_part_count"),
      reasoningChars: getNumberMetadata(errorMetadata, "reasoning_chars"),
      emptyPrompt: errorMetadata?.empty_prompt === true,
      truncationDroppedAllMessages:
        errorMetadata?.truncation_dropped_all_messages === true,
      existingMessagesCount: getNumberMetadata(
        errorMetadata,
        "existing_messages_count",
      ),
      newMessagesCount: getNumberMetadata(errorMetadata, "new_messages_count"),
      allMessagesCount: getNumberMetadata(errorMetadata, "all_messages_count"),
      totalTokensBefore: getNumberMetadata(
        errorMetadata,
        "total_tokens_before",
      ),
      maxTokens: getNumberMetadata(errorMetadata, "max_tokens"),
      fileIdsCount: getNumberMetadata(errorMetadata, "file_ids_count"),
      largestFileToken: getNumberMetadata(errorMetadata, "largest_file_token"),
    };
  }

  return {
    category: classifyProviderDashboardCategory(error, details),
    code: typeof details.errorCode === "string" ? details.errorCode : undefined,
    name:
      typeof details.errorName === "string"
        ? details.errorName
        : "UnknownError",
    message: errorMessage,
    loginRequired: false,
    statusCode:
      typeof details.statusCode === "number" ? details.statusCode : undefined,
  };
};

export const getTerminalProviderStreamError = (
  state:
    | Pick<AgentStreamState, "streamFinishReason" | "providerError">
    | undefined,
): unknown | undefined => {
  if (!state) return undefined;
  if (state.streamFinishReason !== "error") return undefined;
  if (state.providerError) return state.providerError;

  return Object.assign(
    new Error("Provider stream finished with error finish reason"),
    {
      name: "ProviderStreamError",
      finishReason: state.streamFinishReason,
    },
  );
};

export const isTerminalProviderStreamError = (
  state:
    | Pick<AgentStreamState, "streamFinishReason" | "providerError">
    | undefined,
): boolean => state?.streamFinishReason === "error";

export const recordTriggerChatFailureForDashboard = async (
  error: unknown,
  context: {
    taskId: string;
    chatId: string;
    userId: string;
    runId: string;
    phase: "setup" | "streaming";
  },
) => {
  const summary = classifyTriggerChatError(error);
  const runStatus =
    summary.category === "chat_not_found" ? "chat_not_found" : "failed";
  metadata
    .set("status", runStatus)
    .set("errorCategory", summary.category)
    .set("errorName", summary.name)
    .set("errorMessage", summary.message)
    .set("loginRequired", summary.loginRequired)
    .set("failedPhase", context.phase)
    .set("failedAt", new Date().toISOString());

  if (summary.code) metadata.set("errorCode", summary.code);
  if (summary.statusCode) metadata.set("errorStatusCode", summary.statusCode);
  if (summary.cause) metadata.set("errorCause", summary.cause);
  if (summary.dbOperation) metadata.set("dbOperation", summary.dbOperation);
  if (summary.dbErrorName) metadata.set("dbErrorName", summary.dbErrorName);
  if (summary.dbErrorMessage)
    metadata.set("dbErrorMessage", summary.dbErrorMessage);
  if (summary.partsSizeKb != null)
    metadata.set("messagePartsSizeKb", summary.partsSizeKb);
  if (summary.partCount != null)
    metadata.set("messagePartCount", summary.partCount);
  if (summary.largestPartType)
    metadata.set("largestPartType", summary.largestPartType);
  if (summary.largestPartSizeKb != null)
    metadata.set("largestPartSizeKb", summary.largestPartSizeKb);
  if (summary.toolPartCount != null)
    metadata.set("toolPartCount", summary.toolPartCount);
  if (summary.dataPartCount != null)
    metadata.set("dataPartCount", summary.dataPartCount);
  if (summary.reasoningChars != null)
    metadata.set("reasoningChars", summary.reasoningChars);
  if (summary.emptyPrompt) metadata.set("emptyPrompt", true);
  if (summary.truncationDroppedAllMessages) {
    metadata.set("truncationDroppedAllMessages", true);
  }
  if (summary.existingMessagesCount != null)
    metadata.set("existingMessagesCount", summary.existingMessagesCount);
  if (summary.newMessagesCount != null)
    metadata.set("newMessagesCount", summary.newMessagesCount);
  if (summary.allMessagesCount != null)
    metadata.set("allMessagesCount", summary.allMessagesCount);
  if (summary.totalTokensBefore != null)
    metadata.set("totalTokensBefore", summary.totalTokensBefore);
  if (summary.maxTokens != null) metadata.set("maxTokens", summary.maxTokens);
  if (summary.fileIdsCount != null)
    metadata.set("fileIdsCount", summary.fileIdsCount);
  if (summary.largestFileToken != null)
    metadata.set("largestFileToken", summary.largestFileToken);

  const errorTags = [`error_${summary.category}`];
  if (summary.code) {
    errorTags.push(`error_code_${sanitizeTriggerTagValue(summary.code)}`);
  }
  await tags.add(errorTags);

  const logFields = {
    taskId: context.taskId,
    chatId: context.chatId,
    userId: context.userId,
    runId: context.runId,
    phase: context.phase,
    ...summary,
  };
  if (summary.category === "chat_not_found") {
    triggerLogger.warn(
      `[${context.taskId}] run ended because chat is missing`,
      {
        ...logFields,
        status: runStatus,
      },
    );
  } else {
    triggerLogger.error(`[${context.taskId}] run failed`, logFields);
  }

  await metadata.flush();
};

export const recordTriggerChatHandledRateLimitForDashboard = async (
  error: ChatSDKError,
  context: {
    taskId: string;
    chatId: string;
    userId: string;
    runId: string;
  },
) => {
  const summary = classifyTriggerChatError(error);
  metadata
    .set("status", "rate_limited")
    .set("blockedCategory", "rate_limit")
    .set("blockedCode", summary.code ?? "rate_limit:chat")
    .set("blockedMessage", summary.message)
    .set("blockedAt", new Date().toISOString());

  if (summary.statusCode) metadata.set("blockedStatusCode", summary.statusCode);

  await tags.add([
    "rate_limited",
    `blocked_code_${sanitizeTriggerTagValue(summary.code ?? "rate_limit_chat")}`,
  ]);

  triggerLogger.info(`[${context.taskId}] run rate limited`, {
    taskId: context.taskId,
    chatId: context.chatId,
    userId: context.userId,
    runId: context.runId,
    ...summary,
  });

  await metadata.flush();
};
