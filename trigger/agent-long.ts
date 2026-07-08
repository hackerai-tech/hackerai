import {
  task,
  tags,
  metadata,
  logger as triggerLogger,
} from "@trigger.dev/sdk";
import * as triggerSdk from "@trigger.dev/sdk";
import { agentUiStream } from "./streams";
import {
  createUIMessageStream,
  generateId,
  type UIMessageStreamWriter,
  UIMessage,
} from "ai";
import type { Geo } from "@vercel/functions";
import PostHogClient from "@/app/posthog";

import { systemPrompt } from "@/lib/system-prompt";
import { getResumeSection } from "@/lib/system-prompt/resume";
import { createTools } from "@/lib/ai/tools";
import { ptySessionManager } from "@/lib/ai/tools/utils/pty-session-manager";
import { generateTitleFromUserMessageWithWriter } from "@/lib/actions";
import { createTrackedProvider } from "@/lib/ai/providers";
import { processChatMessages } from "@/lib/chat/chat-processor";
import { summarizeIncompleteToolParts } from "@/lib/chat/tool-abort-utils";
import {
  hasVisibleAssistantContent,
  shouldSkipAbortedMessageSave,
  shouldUseUpdateOnlyForAbortedSave,
} from "@/lib/chat/abort-persistence";
import {
  sendRateLimitWarnings,
  SummarizationTracker,
  appendSystemReminderToLastUserMessage,
  estimatePreflightInputTokens,
  buildExtraUsageConfig,
  computeContextUsage,
  isContextUsageEnabled,
  isProviderApiError,
  injectNotesIntoMessages,
  getRetryFallbackModel,
  resolveServedModelForCostAccounting,
} from "@/lib/api/chat-stream-helpers";
import {
  BudgetMonitor,
  captureBudgetSnapshot,
} from "@/lib/chat/budget-monitor";
import { UsageTracker } from "@/lib/usage-tracker";
import {
  acquireFreeRunConcurrencyLock,
  checkFreeMonthlyCostLimit,
  checkRateLimit,
  deductUsage,
  deductUsageDelta,
  addUsageDeductionDelta,
  createUsageSettlementState,
  getUsageSettlementInitialDeduction,
  getUnsettledUsagePoints,
  recordFreeMonthlyCost,
  replaceUsageSettlementState,
  shouldSettleUsageMidRun,
  UsageRefundTracker,
} from "@/lib/rate-limit";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import {
  saveMessage,
  updateChat,
  getUserCustomization,
  setActiveTriggerRun,
  setActiveAgentApprovalPending,
  getMessagesByChatId,
  prepareForNewStream,
  setConvexUrl,
} from "@/lib/db/actions";
import {
  getMaxTokensForSubscription,
  safeCountTokens,
} from "@/lib/token-utils";
import { getBaseTodosForRequest } from "@/lib/utils/todo-utils";
import {
  writeAutoContinue,
  writeUploadStartStatus,
  writeUploadCompleteStatus,
} from "@/lib/utils/stream-writer-utils";
import {
  getSandboxUploadFailureMetadata,
  uploadSandboxFiles,
  getUploadBasePath,
  rewriteSandboxFilePathsInMessages,
} from "@/lib/utils/sandbox-file-utils";
import {
  getEmptyProcessedMessagesCause,
  getEmptyProcessedMessagesMetadata,
} from "@/lib/utils/local-attachment-messages";
import {
  captureAgentBudgetAbort,
  captureAgentCompletionAnalytics,
  captureToolCalls,
  captureUsageCost,
  createChatLogger,
  type ChatLogger,
} from "@/lib/api/chat-logger";
import {
  LEGACY_AGENT_API_ENDPOINT,
  type AgentApiEndpoint,
} from "@/lib/api/agent-endpoints";
import { phLogger } from "@/lib/posthog/server";
import {
  extractErrorDetails,
  getProviderErrorCategory,
  getUserFriendlyProviderError,
} from "@/lib/utils/error-utils";
import { ChatSDKError } from "@/lib/errors";
import type { Id } from "@/convex/_generated/dataModel";
import type {
  SubscriptionTier,
  Todo,
  SandboxPreference,
  SelectedModel,
  AgentPermissionMode,
  AgentToolApprovalInputRecord,
  AgentToolApprovalRequest,
  AgentToolApprovalRequester,
  RateLimitInfo,
  SandboxBootInfo,
  ToolFailureLogEvent,
} from "@/types";
import { canUseExtraUsage, normalizeMaxModelForSubscription } from "@/types";
import {
  createAgentStream,
  initAgentStreamState,
  type AgentStreamContext,
  type AgentStreamState,
} from "@/lib/api/agent-stream-runner";
import {
  assertLocalSandboxFallbackAllowed,
  getSandboxFallbackPromptReminder,
  prepareSandboxContextForPrompt,
  writeSandboxFallbackEvent,
} from "@/lib/ai/tools/utils/sandbox-fallback";
import {
  AGENT_LONG_HEARTBEAT_INTERVAL_MS,
  AGENT_LONG_HEARTBEAT_PART_TYPE,
  stripAgentLongHeartbeatParts,
} from "@/lib/chat/agent-long-heartbeat";
import {
  BUDGET_EXHAUSTION_FINISH_REASON,
  PREEMPTIVE_TIMEOUT_FINISH_REASON,
} from "@/lib/chat/stop-conditions";
import {
  detectAssistantContentLoopFromParts,
  shouldRetryProviderStreamAfterInterruptedToolInput,
  shouldRetryAgentLongWithFallback,
} from "@/lib/chat/agent-long-provider-retry";
import {
  omitImageViewToolResultsForProviderRetry,
  omitTrailingStepStartAssistantMessage,
} from "@/lib/chat/multimodal-tool-result-recovery";
import { FREE_AGENT_LONG_RUN_LOCK_TTL_SECONDS } from "@/lib/rate-limit/free-config";

const AGENT_LONG_FREE_MAX_DURATION_SECONDS = 60 * 60;
const AGENT_LONG_PAID_MAX_DURATION_SECONDS = 2 * 60 * 60;
const AGENT_LONG_CLEANUP_GRACE_MS = 2 * 60 * 1000;
const AGENT_LONG_TRIGGER_MAX_DURATION_SECONDS =
  AGENT_LONG_PAID_MAX_DURATION_SECONDS;
const AGENT_APPROVAL_TIMEOUT = "6h";

type TriggerSessionWaitResult<T> =
  { ok: true; output: T } | { ok: false; error?: unknown };

type TriggerSessionsApi = {
  open(idOrExternalId: string): {
    in: {
      wait<T>(options: {
        timeout: string;
      }): Promise<TriggerSessionWaitResult<T>>;
    };
  };
  close(idOrExternalId: string, body?: { reason?: string }): Promise<unknown>;
};

const triggerSessions = (
  triggerSdk as unknown as { sessions?: TriggerSessionsApi }
).sessions;

const getAgentLongPlanDurationMs = (subscription: SubscriptionTier) =>
  (subscription === "free"
    ? AGENT_LONG_FREE_MAX_DURATION_SECONDS
    : AGENT_LONG_PAID_MAX_DURATION_SECONDS) * 1000;

const getAgentLongMaxDurationMs = (subscription: SubscriptionTier) =>
  Math.max(
    0,
    getAgentLongPlanDurationMs(subscription) - AGENT_LONG_CLEANUP_GRACE_MS,
  );

type AgentLongUiStreamPart = Parameters<UIMessageStreamWriter["write"]>[0];

const createAgentLongHeartbeatPart = (
  phase: "setup" | "model_stream",
): AgentLongUiStreamPart =>
  ({
    type: AGENT_LONG_HEARTBEAT_PART_TYPE,
    data: { at: Date.now(), phase },
    transient: true,
  }) as AgentLongUiStreamPart;

const writeAgentLongFastStart = (
  writer: UIMessageStreamWriter,
  phase: "setup" | "model_stream",
): void => {
  writer.write(createAgentLongHeartbeatPart(phase));
};

const isAgentToolApprovalInputRecord = (
  value: unknown,
): value is AgentToolApprovalInputRecord => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<AgentToolApprovalInputRecord>;
  return (
    record.type === "agent-tool-approval" &&
    typeof record.approvalId === "string" &&
    typeof record.toolCallId === "string" &&
    (record.decision === "approve" || record.decision === "deny") &&
    (record.grant === "full_access" || record.grant === "target_prefix") &&
    (record.targetPrefix === undefined ||
      typeof record.targetPrefix === "string") &&
    (record.targetKind === undefined ||
      record.targetKind === "terminal_command" ||
      record.targetKind === "terminal_interaction" ||
      record.targetKind === "file_change") &&
    (record.message === undefined || typeof record.message === "string")
  );
};

type AgentToolApprovalTargetGrant = {
  kind: NonNullable<AgentToolApprovalInputRecord["targetKind"]>;
  prefix: string;
};

const getApprovalGrantKindForRequest = (
  request: AgentToolApprovalRequest,
): AgentToolApprovalTargetGrant["kind"] => {
  if (request.operation === "terminal_execute") return "terminal_command";
  if (request.operation === "terminal_interact") return "terminal_interaction";
  return "file_change";
};

const matchesApprovalTargetGrant = (
  request: AgentToolApprovalRequest,
  grant: AgentToolApprovalTargetGrant,
): boolean => {
  const target = request.target.trim();
  const prefix = grant.prefix.trim();
  if (!prefix) return false;
  return (
    grant.kind === getApprovalGrantKindForRequest(request) &&
    target.startsWith(prefix)
  );
};

const buildDeniedApprovalReason = (message: string | undefined): string => {
  const trimmed = message?.trim();
  if (!trimmed) return "The user denied approval for this operation.";
  return `The user denied approval for this operation and said: ${trimmed}`;
};

type TriggerSessionInputWaitOutcome =
  | {
      status: "input";
      result: TriggerSessionWaitResult<AgentToolApprovalInputRecord>;
    }
  | { status: "aborted" };

const waitForApprovalInput = async (
  session: ReturnType<TriggerSessionsApi["open"]>,
  signal: AbortSignal,
): Promise<TriggerSessionInputWaitOutcome> => {
  if (signal.aborted) return { status: "aborted" };

  let removeAbortListener = () => {};
  const abortPromise = new Promise<TriggerSessionInputWaitOutcome>(
    (resolve) => {
      const abort = () => resolve({ status: "aborted" });
      signal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", abort);
    },
  );

  try {
    return await Promise.race([
      session.in
        .wait<AgentToolApprovalInputRecord>({
          timeout: AGENT_APPROVAL_TIMEOUT,
        })
        .then((result) => ({ status: "input", result }) as const),
      abortPromise,
    ]);
  } finally {
    removeAbortListener();
  }
};

const buildAgentToolApprovalRequester = ({
  agentPermissionMode,
  approvalSessionId,
  writer,
  chatId,
  userId,
  runId,
  signal,
}: {
  agentPermissionMode: AgentPermissionMode;
  approvalSessionId?: string;
  writer: UIMessageStreamWriter;
  chatId: string;
  userId: string;
  runId: string;
  signal: AbortSignal;
}): AgentToolApprovalRequester | undefined => {
  if (agentPermissionMode !== "ask_approval") return undefined;
  let approvalQueue: Promise<void> = Promise.resolve();
  const approvedTargetGrants: AgentToolApprovalTargetGrant[] = [];
  const setApprovalPending = async (pending: boolean) => {
    if (!approvalSessionId) return;
    try {
      await setActiveAgentApprovalPending({
        chatId,
        pending,
        expectedRunId: runId,
        expectedApprovalSessionId: approvalSessionId,
      });
    } catch (error) {
      console.error("[agent-long] failed to update approval pending state:", {
        pending,
        error,
      });
    }
  };

  return async (request: AgentToolApprovalRequest) => {
    const previousApproval = approvalQueue.catch(() => {});
    let releaseApproval!: () => void;
    approvalQueue = previousApproval.then(
      () =>
        new Promise<void>((resolve) => {
          releaseApproval = resolve;
        }),
    );

    await previousApproval;
    let approvalPendingMarked = false;
    try {
      const approvalId = generateId();
      const existingGrant = approvedTargetGrants.find((grant) =>
        matchesApprovalTargetGrant(request, grant),
      );
      if (existingGrant) {
        metadata
          .set("approvalStatus", "auto_approved")
          .set("approvalToolName", request.toolName)
          .set("approvalOperation", request.operation);
        triggerLogger.info("[agent-long] tool approval reused", {
          chatId,
          userId,
          runId,
          approvalId,
          tool_name: request.toolName,
          operation: request.operation,
          target_kind: existingGrant.kind,
          target_prefix: existingGrant.prefix,
        });
        return { approved: true, approvalId };
      }

      if (!approvalSessionId) {
        return {
          approved: false,
          approvalId,
          reason:
            "Approval session is unavailable. Please retry the Agent run.",
        };
      }

      if (signal.aborted) {
        metadata.set("approvalStatus", "aborted");
        return {
          approved: false,
          approvalId,
          reason: "The Agent run was stopped before approval was requested.",
        };
      }

      if (!triggerSessions) {
        metadata.set("approvalStatus", "sessions_unavailable");
        return {
          approved: false,
          approvalId,
          reason:
            "Approval sessions are unavailable. Please retry the Agent run.",
        };
      }

      await setApprovalPending(true);
      approvalPendingMarked = true;

      writer.write({
        type: "tool-approval-request",
        toolCallId: request.toolCallId,
        approvalId,
      } as AgentLongUiStreamPart);

      metadata
        .set("approvalStatus", "pending")
        .set("approvalId", approvalId)
        .set("approvalToolName", request.toolName)
        .set("approvalOperation", request.operation);

      triggerLogger.info("[agent-long] waiting for tool approval", {
        chatId,
        userId,
        runId,
        approvalId,
        tool_name: request.toolName,
        operation: request.operation,
        target: request.target.slice(0, 200),
      });

      const session = triggerSessions.open(approvalSessionId);
      while (!signal.aborted) {
        const waitOutcome = await waitForApprovalInput(session, signal);
        if (waitOutcome.status === "aborted") break;

        const next = waitOutcome.result;
        if (!next.ok) {
          metadata.set("approvalStatus", "timed_out");
          return {
            approved: false,
            approvalId,
            reason: "Approval timed out before the tool could run.",
          };
        }

        if (!isAgentToolApprovalInputRecord(next.output)) continue;
        if (
          next.output.approvalId !== approvalId ||
          next.output.toolCallId !== request.toolCallId
        ) {
          continue;
        }

        metadata
          .set("approvalStatus", next.output.decision)
          .set("approvalResolvedAt", Date.now());

        if (next.output.decision === "approve") {
          if (
            next.output.grant === "target_prefix" &&
            next.output.targetPrefix?.trim()
          ) {
            const targetKind = getApprovalGrantKindForRequest(request);
            approvedTargetGrants.push({
              kind: targetKind,
              prefix: next.output.targetPrefix.trim(),
            });
            metadata
              .set("approvalGrant", "target_prefix")
              .set("approvalTargetKind", targetKind)
              .set("approvalTargetPrefix", next.output.targetPrefix.trim());
          }
          triggerLogger.info("[agent-long] tool approval granted", {
            chatId,
            userId,
            runId,
            approvalId,
            tool_name: request.toolName,
            operation: request.operation,
            grant: next.output.grant,
            target_kind: getApprovalGrantKindForRequest(request),
            target_prefix: next.output.targetPrefix,
          });
          return { approved: true, approvalId };
        }

        triggerLogger.info("[agent-long] tool approval denied", {
          chatId,
          userId,
          runId,
          approvalId,
          tool_name: request.toolName,
          operation: request.operation,
        });
        return {
          approved: false,
          approvalId,
          reason: buildDeniedApprovalReason(next.output.message),
        };
      }

      metadata.set("approvalStatus", "aborted");
      return {
        approved: false,
        approvalId,
        reason: "The Agent run was stopped before approval was received.",
      };
    } finally {
      if (approvalPendingMarked) {
        await setApprovalPending(false);
      }
      releaseApproval();
    }
  };
};

const MAX_TRIGGER_ERROR_MESSAGE_LENGTH = 500;
const TRIGGER_TAG_MAX_LENGTH = 64;

const truncateForTriggerMetadata = (value: string) =>
  value.length > MAX_TRIGGER_ERROR_MESSAGE_LENGTH
    ? `${value.slice(0, MAX_TRIGGER_ERROR_MESSAGE_LENGTH)}...`
    : value;

const sanitizeTriggerTagValue = (value: string, maxLength: number) =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, maxLength);

const buildTriggerTag = (prefix: string, value: string) =>
  `${prefix}${sanitizeTriggerTagValue(
    value,
    Math.max(0, TRIGGER_TAG_MAX_LENGTH - prefix.length),
  )}`;

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

const getBooleanMetadata = (
  metadata: Record<string, unknown> | undefined,
  key: string,
) => {
  const value = metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
};

type TriggerMetadataPrimitive = boolean | number | string;

const EMPTY_AFTER_PROCESSING_TRIGGER_METADATA_KEYS = [
  ["processing_input_message_count", "processingInputMessageCount"],
  ["processing_input_user_message_count", "processingInputUserMessageCount"],
  [
    "processing_input_assistant_message_count",
    "processingInputAssistantMessageCount",
  ],
  [
    "processing_input_system_message_count",
    "processingInputSystemMessageCount",
  ],
  [
    "processing_input_other_role_message_count",
    "processingInputOtherRoleMessageCount",
  ],
  [
    "processing_input_empty_parts_message_count",
    "processingInputEmptyPartsMessageCount",
  ],
  ["processing_input_part_count", "processingInputPartCount"],
  ["processing_input_text_part_count", "processingInputTextPartCount"],
  [
    "processing_input_nonempty_text_part_count",
    "processingInputNonemptyTextPartCount",
  ],
  ["processing_input_file_part_count", "processingInputFilePartCount"],
  ["processing_input_file_with_url_count", "processingInputFileWithUrlCount"],
  [
    "processing_input_file_with_file_id_count",
    "processingInputFileWithFileIdCount",
  ],
  [
    "processing_input_local_desktop_file_part_count",
    "processingInputLocalDesktopFilePartCount",
  ],
  [
    "processing_input_local_desktop_file_with_local_path_count",
    "processingInputLocalDesktopFileWithLocalPathCount",
  ],
  [
    "processing_input_local_desktop_file_missing_local_path_count",
    "processingInputLocalDesktopFileMissingLocalPathCount",
  ],
  ["processing_input_ui_only_part_count", "processingInputUiOnlyPartCount"],
  [
    "processing_input_step_start_part_count",
    "processingInputStepStartPartCount",
  ],
  [
    "processing_input_reasoning_part_count",
    "processingInputReasoningPartCount",
  ],
  [
    "processing_input_nonempty_reasoning_part_count",
    "processingInputNonemptyReasoningPartCount",
  ],
  ["processing_input_tool_part_count", "processingInputToolPartCount"],
  ["processing_input_data_part_count", "processingInputDataPartCount"],
  ["processing_input_other_part_count", "processingInputOtherPartCount"],
  ["processing_input_regenerate", "processingInputRegenerate"],
  ["processing_input_auto_continue", "processingInputAutoContinue"],
  ["processing_input_temporary", "processingInputTemporary"],
  ["processing_input_sandbox_preference", "processingInputSandboxPreference"],
] as const;

const getPrimitiveMetadata = (
  metadata: Record<string, unknown> | undefined,
  key: string,
): TriggerMetadataPrimitive | undefined => {
  const value = metadata?.[key];
  if (
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  return undefined;
};

const getEmptyAfterProcessingTriggerMetadata = (
  metadata: Record<string, unknown> | undefined,
): Record<string, TriggerMetadataPrimitive> | undefined => {
  if (metadata?.empty_after_processing !== true) return undefined;

  const diagnostics: Record<string, TriggerMetadataPrimitive> = {
    emptyAfterProcessing: true,
  };
  for (const [
    sourceKey,
    targetKey,
  ] of EMPTY_AFTER_PROCESSING_TRIGGER_METADATA_KEYS) {
    const value = getPrimitiveMetadata(metadata, sourceKey);
    if (value !== undefined) diagnostics[targetKey] = value;
  }
  return diagnostics;
};

const OPERATIONAL_RATE_LIMIT_CAUSE_PATTERNS = [
  /rate limiting service .*not configured/i,
  /rate limiting service unavailable/i,
  /extra usage billing is temporarily unavailable/i,
];

type AgentLongErrorSummary = {
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
  emptyAfterProcessing?: boolean;
  emptyAfterProcessingMetadata?: Record<string, TriggerMetadataPrimitive>;
  localSandboxFallbackBlocked?: boolean;
  sandboxFallbackReason?: string;
  requestedPreference?: string;
  actualSandbox?: string;
  uploadFailureKind?: string;
  uploadFailureCause?: string;
  uploadFailureTransientSandboxCommand?: boolean;
  uploadFailureProtocol?: string;
  uploadFailureUrlLength?: number;
  uploadRetriedWithFreshSandbox?: boolean;
};

const isHandledUserRateLimitError = (error: unknown): error is ChatSDKError => {
  if (!(error instanceof ChatSDKError)) return false;
  if (error.type !== "rate_limit" || error.surface !== "chat") return false;

  const cause = typeof error.cause === "string" ? error.cause : error.message;
  return !OPERATIONAL_RATE_LIMIT_CAUSE_PATTERNS.some((pattern) =>
    pattern.test(cause),
  );
};

const isChatNotFoundError = (error: ChatSDKError): boolean => {
  if (error.type === "not_found" && error.surface === "chat") return true;
  return (
    getStringMetadata(error.metadata, "db_error_code") === "CHAT_NOT_FOUND"
  );
};

const USER_CORRECTABLE_AGENT_LONG_ERROR_CATEGORIES = new Set([
  "chat_not_found",
  "login_required",
  "empty_prompt",
  "input_too_large",
  "empty_after_processing",
  "local_sandbox_fallback_blocked",
]);

const isUserCorrectableAgentLongErrorCategory = (category: string): boolean =>
  USER_CORRECTABLE_AGENT_LONG_ERROR_CATEGORIES.has(category);

const getAgentLongErrorRunStatus = (category: string): string => {
  if (category === "chat_not_found") return "chat_not_found";
  if (isUserCorrectableAgentLongErrorCategory(category)) {
    return "user_correctable";
  }
  return "failed";
};

const TRIGGER_REALTIME_TRANSPORT_ERROR_PATTERNS = [
  /@s2-dev\/streamstore/i,
  /S2AppendSession/i,
  /S2MetadataStream/i,
  /StreamsWriterV2/i,
  /sendBatchNonBlocking/i,
  /Max attempts \(\d+\) exhausted: Request timeout after \d+ms \(\d+ records, \d+ bytes\)/i,
  /Request timeout after \d+ms \(\d+ records, \d+ bytes\)/i,
];

const getErrorField = (error: unknown, field: string): string | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
};

const isTriggerRealtimeTransportError = (error: unknown): boolean => {
  const details = extractErrorDetails(error);
  const candidates = [
    getErrorField(error, "name"),
    getErrorField(error, "code"),
    typeof details.errorMessage === "string" ? details.errorMessage : undefined,
    error instanceof Error ? error.stack : undefined,
  ]
    .filter((value): value is string => !!value)
    .join("\n");

  if (!candidates) return false;
  return TRIGGER_REALTIME_TRANSPORT_ERROR_PATTERNS.some((pattern) =>
    pattern.test(candidates),
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

const classifyAgentLongError = (error: unknown): AgentLongErrorSummary => {
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
                : errorMetadata?.empty_after_processing === true
                  ? "empty_after_processing"
                  : errorMetadata?.localSandboxFallbackBlocked === true
                    ? "local_sandbox_fallback_blocked"
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
      emptyAfterProcessing:
        errorMetadata?.empty_after_processing === true || undefined,
      emptyAfterProcessingMetadata:
        getEmptyAfterProcessingTriggerMetadata(errorMetadata),
      localSandboxFallbackBlocked:
        errorMetadata?.localSandboxFallbackBlocked === true || undefined,
      sandboxFallbackReason: getStringMetadata(
        errorMetadata,
        "sandboxFallbackReason",
      ),
      requestedPreference: getStringMetadata(
        errorMetadata,
        "requestedPreference",
      ),
      actualSandbox: getStringMetadata(errorMetadata, "actualSandbox"),
      uploadFailureKind: getStringMetadata(
        errorMetadata,
        "upload_failure_kind",
      ),
      uploadFailureCause: getStringMetadata(
        errorMetadata,
        "upload_failure_cause",
      ),
      uploadFailureTransientSandboxCommand: getBooleanMetadata(
        errorMetadata,
        "upload_failure_transient_sandbox_command",
      ),
      uploadFailureProtocol: getStringMetadata(
        errorMetadata,
        "upload_failure_protocol",
      ),
      uploadFailureUrlLength: getNumberMetadata(
        errorMetadata,
        "upload_failure_url_length",
      ),
      uploadRetriedWithFreshSandbox: getBooleanMetadata(
        errorMetadata,
        "upload_retried_with_fresh_sandbox",
      ),
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

const getTerminalProviderStreamError = (
  state:
    Pick<AgentStreamState, "streamFinishReason" | "providerError"> | undefined,
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

const isTerminalProviderStreamError = (
  state:
    Pick<AgentStreamState, "streamFinishReason" | "providerError"> | undefined,
): boolean => state?.streamFinishReason === "error";

type RecordedAgentLongFailure = {
  userCorrectable: boolean;
};

const recordAgentLongFailureForDashboard = async (
  error: unknown,
  context: {
    chatId: string;
    userId: string;
    runId: string;
    phase: "setup" | "streaming";
  },
): Promise<RecordedAgentLongFailure> => {
  const summary = classifyAgentLongError(error);
  const runStatus = getAgentLongErrorRunStatus(summary.category);
  const isExpectedUserCorrectableError =
    isUserCorrectableAgentLongErrorCategory(summary.category);
  const terminalAt = new Date().toISOString();

  metadata
    .set("status", runStatus)
    .set("errorCategory", summary.category)
    .set("errorName", summary.name)
    .set("errorMessage", summary.message)
    .set("loginRequired", summary.loginRequired)
    .set("terminalPhase", context.phase);
  if (isExpectedUserCorrectableError) {
    metadata.set("userCorrectable", true).set("endedAt", terminalAt);
  } else {
    metadata.set("failedPhase", context.phase).set("failedAt", terminalAt);
  }

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
  if (summary.emptyAfterProcessingMetadata) {
    for (const [key, value] of Object.entries(
      summary.emptyAfterProcessingMetadata,
    )) {
      metadata.set(key, value);
    }
  }
  if (summary.localSandboxFallbackBlocked) {
    metadata.set("localSandboxFallbackBlocked", true);
  }
  if (summary.sandboxFallbackReason)
    metadata.set("sandboxFallbackReason", summary.sandboxFallbackReason);
  if (summary.requestedPreference)
    metadata.set("requestedPreference", summary.requestedPreference);
  if (summary.actualSandbox)
    metadata.set("actualSandbox", summary.actualSandbox);
  if (summary.uploadFailureKind)
    metadata.set("uploadFailureKind", summary.uploadFailureKind);
  if (summary.uploadFailureCause)
    metadata.set("uploadFailureCause", summary.uploadFailureCause);
  if (summary.uploadFailureTransientSandboxCommand != null) {
    metadata.set(
      "uploadFailureTransientSandboxCommand",
      summary.uploadFailureTransientSandboxCommand,
    );
  }
  if (summary.uploadFailureProtocol)
    metadata.set("uploadFailureProtocol", summary.uploadFailureProtocol);
  if (summary.uploadFailureUrlLength != null)
    metadata.set("uploadFailureUrlLength", summary.uploadFailureUrlLength);
  if (summary.uploadRetriedWithFreshSandbox != null) {
    metadata.set(
      "uploadRetriedWithFreshSandbox",
      summary.uploadRetriedWithFreshSandbox,
    );
  }

  const terminalTags = [
    isExpectedUserCorrectableError
      ? `user_correctable_${summary.category}`
      : `error_${summary.category}`,
  ];
  if (summary.code) {
    terminalTags.push(
      isExpectedUserCorrectableError
        ? buildTriggerTag("user_correctable_code_", summary.code)
        : buildTriggerTag("error_code_", summary.code),
    );
  }
  await tags.add(terminalTags);

  const { emptyAfterProcessingMetadata, ...summaryLogFields } = summary;
  const logFields = {
    chatId: context.chatId,
    userId: context.userId,
    runId: context.runId,
    phase: context.phase,
    ...summaryLogFields,
    ...emptyAfterProcessingMetadata,
  };

  if (isExpectedUserCorrectableError) {
    triggerLogger.warn(
      summary.category === "chat_not_found"
        ? "[agent-long] run ended because chat is missing"
        : "[agent-long] run ended with user-correctable request error",
      {
        ...logFields,
        status: runStatus,
      },
    );
  } else {
    triggerLogger.error("[agent-long] run failed", logFields);
  }

  await metadata.flush();
  return {
    userCorrectable: isExpectedUserCorrectableError,
  };
};

const recordAgentLongHandledRateLimitForDashboard = async (
  error: ChatSDKError,
  context: {
    chatId: string;
    userId: string;
    runId: string;
  },
) => {
  const summary = classifyAgentLongError(error);
  metadata
    .set("status", "rate_limited")
    .set("blockedCategory", "rate_limit")
    .set("blockedCode", summary.code ?? "rate_limit:chat")
    .set("blockedMessage", summary.message)
    .set("blockedAt", new Date().toISOString());

  if (summary.statusCode) metadata.set("blockedStatusCode", summary.statusCode);

  await tags.add([
    "rate_limited",
    buildTriggerTag("blocked_code_", summary.code ?? "rate_limit_chat"),
  ]);

  triggerLogger.info("[agent-long] run rate limited", {
    chatId: context.chatId,
    userId: context.userId,
    runId: context.runId,
    ...summary,
  });

  await metadata.flush();
};

const recordAgentLongHandledToolFailureForDashboard = async (
  failure: ToolFailureLogEvent,
  context: {
    chatId: string;
    userId: string;
    runId: string;
    handledToolFailureCount: number;
  },
) => {
  const failedAt = new Date().toISOString();
  metadata
    .set("handledToolFailureCount", context.handledToolFailureCount)
    .set("lastHandledToolFailure", failure.tool_name)
    .set("lastHandledToolFailureProvider", failure.provider)
    .set("lastHandledToolFailureEvent", failure.event)
    .set("lastHandledToolFailureAt", failedAt);
  if (failure.status != null) {
    metadata.set("lastHandledToolFailureStatus", failure.status);
  }

  await tags.add([
    "handled_tool_failure",
    buildTriggerTag("tool_", failure.tool_name),
    buildTriggerTag("tool_provider_", failure.provider),
    ...(failure.status != null
      ? [buildTriggerTag("tool_status_", String(failure.status))]
      : []),
  ]);

  triggerLogger.warn("[agent-long] handled tool failure", {
    chatId: context.chatId,
    userId: context.userId,
    runId: context.runId,
    handled_tool_failure_count: context.handledToolFailureCount,
    ...failure,
  });

  await metadata.flush();
};

const withAgentLongStreamHeartbeat = (
  source: ReadableStream<AgentLongUiStreamPart>,
  signal: AbortSignal,
): ReadableStream<AgentLongUiStreamPart> => {
  let reader: ReadableStreamDefaultReader<AgentLongUiStreamPart> | undefined;
  let stopHeartbeat: (() => void) | undefined;

  return new ReadableStream<AgentLongUiStreamPart>({
    start(controller) {
      reader = source.getReader();
      let stopped = false;
      const safeEnqueue = (part: AgentLongUiStreamPart) => {
        try {
          controller.enqueue(part);
        } catch {
          stop();
        }
      };
      const safeClose = () => {
        try {
          controller.close();
        } catch {
          // The consumer may already have canceled the wrapper stream.
        }
      };
      const safeError = (error: unknown) => {
        try {
          controller.error(error);
        } catch {
          // The consumer may already have canceled the wrapper stream.
        }
      };

      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(intervalId);
        signal.removeEventListener("abort", stop);
      };
      stopHeartbeat = stop;

      const intervalId = setInterval(() => {
        if (signal.aborted) {
          stop();
          return;
        }

        safeEnqueue(createAgentLongHeartbeatPart("model_stream"));
      }, AGENT_LONG_HEARTBEAT_INTERVAL_MS);

      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      if (!stopped) {
        safeEnqueue(createAgentLongHeartbeatPart("model_stream"));
      }

      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader!.read();
            if (done) {
              safeClose();
              return;
            }
            safeEnqueue(value);
          }
        } catch (error) {
          safeError(error);
        } finally {
          stop();
          reader?.releaseLock();
        }
      })();
    },
    cancel(reason) {
      stopHeartbeat?.();
      return reader?.cancel(reason);
    },
  });
};

// Shared between run() and onCancel() since onCancel is defined at task scope.
type RunCleanupState = {
  usageRefundTracker: UsageRefundTracker;
  hasObservedUsage: () => boolean;
  chatLogger: ChatLogger | undefined;
  chatId: string;
};
const runCleanupMap = new Map<string, RunCleanupState>();

export type AgentLongPayload = {
  chatId: string;
  userId: string;
  subscription: SubscriptionTier;
  organizationId?: string;
  freeQuotaSubject?: string;
  messages: UIMessage[];
  localDesktopAttachmentsPrepared?: boolean;
  baseTodos: Todo[];
  sandboxPreference?: SandboxPreference;
  agentPermissionMode?: AgentPermissionMode;
  approvalSessionId?: string;
  selectedModel?: SelectedModel;
  userLocation: Geo;
  temporary?: boolean;
  isAutoContinue?: boolean;
  regenerate?: boolean;
  isNewChat?: boolean;
  endpoint?: AgentApiEndpoint;
  convexUrl?: string;
  requestTiming?: {
    routeStartedAt: number;
    triggerRequestedAt: number;
  };
};

export const agentLongTask = task({
  id: "agent-long",
  maxDuration: AGENT_LONG_TRIGGER_MAX_DURATION_SECONDS,
  // Streaming tasks must not retry: a retry emits new chunks into the same
  // "ui" stream the client already subscribed to, producing duplicate output.
  // Provider errors are handled internally via the fallback-model path.
  retry: { maxAttempts: 1 },
  // Right-sized from observed production CPU/memory usage.
  machine: { preset: "small-1x" },

  onCancel: async ({
    ctx,
    runPromise,
  }: {
    ctx: { run: { id: string } };
    runPromise: Promise<unknown>;
  }) => {
    const cleanup = runCleanupMap.get(ctx.run.id);
    if (!cleanup) return;
    await Promise.race([
      runPromise.catch(() => undefined),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (!cleanup.hasObservedUsage()) {
      await cleanup.usageRefundTracker.refund().catch(() => {});
    }
    await ptySessionManager.closeAll(cleanup.chatId).catch(() => {});
    await phLogger.flush().catch(() => {});
    runCleanupMap.delete(ctx.run.id);
  },

  run: async (payload: AgentLongPayload, { ctx, signal: triggerSignal }) => {
    // Point the Convex client at the correct per-branch preview deployment.
    // NEXT_PUBLIC_CONVEX_URL in Trigger.dev's env vars only reflects the
    // main deployment; preview branches each have their own Convex URL.
    if (payload.convexUrl) {
      setConvexUrl(payload.convexUrl);
    }

    const {
      chatId,
      userId,
      subscription,
      organizationId,
      freeQuotaSubject,
      messages,
      localDesktopAttachmentsPrepared,
      sandboxPreference,
      agentPermissionMode = "full_access",
      approvalSessionId,
      selectedModel: rawSelectedModelOverride,
      userLocation,
      temporary,
      isAutoContinue,
      regenerate,
      isNewChat,
      endpoint: payloadEndpoint,
    } = payload;
    let selectedModelOverride = rawSelectedModelOverride;
    const endpoint = payloadEndpoint ?? LEGACY_AGENT_API_ENDPOINT;
    const freeUsageSubject = freeQuotaSubject ?? userId;

    // Stable across retries so a failed-then-retried run upserts the same
    // message record rather than creating a duplicate.
    const assistantMessageId = ctx.run.id;
    const mode = "agent" as const;

    // Capture task start time here, before any async setup, so the
    // elapsedTimeExceeds stop condition counts from task launch rather
    // than stream launch. Without this, slow setup (>2 min) could push
    // the soft stop past the plan-specific runtime cap.
    const taskStartTime = Date.now();
    const agentLongMaxDurationMs = getAgentLongMaxDurationMs(subscription);

    // Tag for dashboard filtering; add subscription tier for paid-only queries.
    await tags.add([`user_${userId}`, `chat_${chatId}`]);
    if (subscription !== "free") await tags.add(`sub_${subscription}`);

    // Lifecycle metadata so the dashboard shows progress for long runs.
    metadata
      .set("status", "setup")
      .set("chatId", chatId)
      .set("endpoint", endpoint)
      .set("triggerPayloadMessageCount", messages.length);
    if (payload.requestTiming) {
      metadata
        .set("routeStartedAt", payload.requestTiming.routeStartedAt)
        .set("triggerRequestedAt", payload.requestTiming.triggerRequestedAt)
        .set(
          "taskStartLatencyMs",
          taskStartTime - payload.requestTiming.triggerRequestedAt,
        );
    }

    const usageRefundTracker = new UsageRefundTracker();
    usageRefundTracker.setUser(userId, subscription, organizationId);
    let releaseFreeRunLock: (() => Promise<void>) | undefined;
    const releaseFreeRunLockOnce = async () => {
      const release = releaseFreeRunLock;
      if (!release) return;
      releaseFreeRunLock = undefined;
      await release();
    };

    let chatLogger: ChatLogger | undefined = createChatLogger({
      chatId,
      endpoint,
    });
    chatLogger.setRequestDetails({
      mode,
      isTemporary: !!temporary,
      isRegenerate: !!regenerate,
    });
    chatLogger.setUser({
      id: userId,
      subscription,
      region: userLocation?.region,
    });

    // Set to true once the real UI stream is piped to agentUiStream. If a
    // pre-stream setup step throws before this, the outer catch emits a
    // synthetic error stream so the frontend receives a proper error chunk
    // instead of a silent abort.
    let streamPiped = false;
    let observedUsageTracker: UsageTracker | undefined;
    const hasObservedUsage = () => !!observedUsageTracker?.hasUsage;
    runCleanupMap.set(ctx.run.id, {
      usageRefundTracker,
      hasObservedUsage,
      chatLogger,
      chatId,
    });

    let agentLongTimeout: ReturnType<typeof setTimeout> | undefined;

    try {
      // Re-fetch from DB so we have fileTokens for summarization.
      // The route already saved the user message; newMessages:[] avoids duplicates.
      const [userCustomization, fetched] = await Promise.all([
        getUserCustomization({ userId }),
        getMessagesByChatId({
          chatId,
          userId,
          subscription,
          newMessages: [],
          regenerate,
          isTemporary: temporary,
          mode,
        }),
      ]);
      const { chat, fileTokens } = fetched;
      const truncatedMessages = fetched.truncatedMessages;
      const extraUsageConfig = await buildExtraUsageConfig({
        userId,
        subscription,
        userCustomization,
        organizationId,
      });
      const extraUsageAvailable = canUseExtraUsage(extraUsageConfig);
      selectedModelOverride =
        normalizeMaxModelForSubscription(selectedModelOverride, subscription, {
          extraUsageAvailable,
        }) ?? undefined;

      const baseTodos: Todo[] = getBaseTodosForRequest(
        (chat?.todos as unknown as Todo[]) || [],
        Array.isArray(payload.baseTodos) ? payload.baseTodos : [],
        { isTemporary: !!temporary, regenerate },
      );

      const uploadBasePath = getUploadBasePath(sandboxPreference);
      const messagesForProcessing =
        localDesktopAttachmentsPrepared && messages.length > 0
          ? messages
          : truncatedMessages.length
            ? truncatedMessages
            : messages;
      const messagesForAccounting = messagesForProcessing;

      let { processedMessages, selectedModel, sandboxFiles } =
        await processChatMessages({
          messages: messagesForProcessing,
          mode,
          userId,
          subscription,
          uploadBasePath,
          modelOverride: selectedModelOverride,
          extraUsageAvailable,
          allowLocalDesktopFiles: sandboxPreference === "desktop",
        });

      if (!processedMessages.length) {
        throw new ChatSDKError(
          "bad_request:api",
          getEmptyProcessedMessagesCause(messagesForProcessing),
          getEmptyProcessedMessagesMetadata(messagesForProcessing, {
            regenerate: !!regenerate,
            isAutoContinue: !!isAutoContinue,
            isTemporary: !!temporary,
            sandboxPreference,
          }),
        );
      }

      const notesEnabled = userCustomization?.include_notes ?? true;

      const estimatedInputTokens = await estimatePreflightInputTokens({
        mode,
        subscription,
        userId,
        selectedModel,
        userCustomization,
        temporary,
        truncatedMessages: messagesForAccounting,
      });

      chatLogger.setChat(
        {
          messageCount: messagesForAccounting.length,
          estimatedInputTokens,
          isNewChat: !!isNewChat,
          fileCount: 0,
          imageCount: 0,
          notesEnabled,
        },
        selectedModel,
      );

      const posthog = PostHogClient();
      chatLogger.getBuilder().setAssistantId(assistantMessageId);

      // Wire trigger.dev's abort signal into a local controller.
      // Fires on runs.cancel() (UI Stop) and Trigger's maxDuration.
      const userStopSignal = new AbortController();
      triggerSignal.addEventListener("abort", () => userStopSignal.abort(), {
        once: true,
      });

      const summarizationTracker = new SummarizationTracker();
      chatLogger.startStream();
      let terminalAgentState: AgentStreamState | undefined;
      let agentLongDurationExceeded = false;
      const markAgentLongDurationExceeded = () => {
        agentLongDurationExceeded = true;
        if (terminalAgentState) {
          terminalAgentState.stoppedDueToElapsedTimeout = true;
          terminalAgentState.streamFinishReason ??=
            PREEMPTIVE_TIMEOUT_FINISH_REASON;
        }
      };
      const agentLongTimeoutDelayMs = Math.max(
        0,
        agentLongMaxDurationMs - (Date.now() - taskStartTime),
      );
      agentLongTimeout = setTimeout(() => {
        markAgentLongDurationExceeded();
        userStopSignal.abort();
      }, agentLongTimeoutDelayMs);

      // Rate limit check happens inside execute so a thrown ChatSDKError
      // (e.g. "exceeded daily messages") flows through createUIMessageStream's
      // onError → an error chunk on the UI stream → useChat renders the
      // friendly message. If we checked it outside, the task would throw
      // before agentUiStream.pipe() registered the stream, and the frontend
      // transport would only see a FAILED status with no error message.
      let rateLimitInfo: RateLimitInfo;

      let streamError: unknown;
      const uiStream = createUIMessageStream({
        onError: (error) => {
          streamError ??= error;
          if (error instanceof ChatSDKError) {
            return typeof error.cause === "string"
              ? error.cause
              : error.message;
          }
          return getUserFriendlyProviderError(error);
        },
        execute: async ({ writer }) => {
          try {
            writeAgentLongFastStart(writer, "setup");
            await assertUserCanMakeCostIncurringRequest(userId);
            if (subscription === "free") {
              const lock = await acquireFreeRunConcurrencyLock(
                freeUsageSubject,
                FREE_AGENT_LONG_RUN_LOCK_TTL_SECONDS,
              );
              releaseFreeRunLock = lock.release;
            }

            rateLimitInfo = await checkRateLimit(
              userId,
              mode,
              subscription,
              estimatedInputTokens,
              extraUsageConfig,
              selectedModel,
              organizationId,
              freeQuotaSubject,
            );

            const freeMonthlyBudgetSnapshot =
              subscription === "free"
                ? await checkFreeMonthlyCostLimit(freeUsageSubject)
                : null;

            usageRefundTracker.recordDeductions(rateLimitInfo);
            chatLogger?.setRateLimit(
              {
                pointsDeducted: rateLimitInfo.pointsDeducted,
                extraUsagePointsDeducted:
                  rateLimitInfo.extraUsagePointsDeducted,
                monthly: rateLimitInfo.monthly,
                remaining: rateLimitInfo.remaining,
                subscription,
              },
              extraUsageConfig,
            );

            sendRateLimitWarnings(writer, {
              subscription,
              mode,
              rateLimitInfo,
              extraUsageConfig,
            });

            let uploadSandboxBootPath: SandboxBootInfo["path"] | null = null;
            let handledToolFailureCount = 0;
            const onToolFailure = (failure: ToolFailureLogEvent) => {
              handledToolFailureCount += 1;
              void recordAgentLongHandledToolFailureForDashboard(failure, {
                chatId,
                userId,
                runId: ctx.run.id,
                handledToolFailureCount,
              }).catch((error) => {
                triggerLogger.warn(
                  "[agent-long] handled tool failure dashboard update failed",
                  {
                    chatId,
                    userId,
                    runId: ctx.run.id,
                    tool_name: failure.tool_name,
                    provider: failure.provider,
                    error_name:
                      error instanceof Error ? error.name : "UnknownError",
                    error_message:
                      error instanceof Error ? error.message : String(error),
                  },
                );
              });
            };
            const requestToolApproval = buildAgentToolApprovalRequester({
              agentPermissionMode,
              approvalSessionId,
              writer,
              chatId,
              userId,
              runId: ctx.run.id,
              signal: userStopSignal.signal,
            });
            const {
              tools,
              ensureSandbox,
              getTodoManager,
              getFileAccumulator,
              sandboxManager,
              getSandboxSessionCost,
              setCurrentModelName,
              getToolsForModel,
            } = createTools(
              userId,
              chatId,
              writer,
              mode,
              userLocation,
              baseTodos,
              notesEnabled,
              !!temporary,
              assistantMessageId,
              sandboxPreference,
              process.env.CONVEX_SERVICE_ROLE_KEY,
              undefined,
              (costDollars: number) => {
                usageTracker.providerCost += costDollars;
                usageTracker.nonModelCost += costDollars;
                chatLogger?.getBuilder().addToolCost(costDollars);
              },
              subscription,
              (info) => {
                uploadSandboxBootPath ??= info.path;
                chatLogger?.setSandboxBoot(info);
              },
              selectedModel,
              onToolFailure,
              requestToolApproval,
            );

            const sendFileMetadataToStream = (
              fileMetadata: Array<{
                fileId: Id<"files">;
                name: string;
                mediaType: string;
                s3Key?: string;
                sizeBytes?: number;
              }>,
            ) => {
              if (!fileMetadata || fileMetadata.length === 0) return;
              writer.write({
                type: "data-file-metadata",
                data: {
                  messageId: assistantMessageId,
                  fileDetails: fileMetadata,
                },
              });
            };

            const sandboxPromptContext = await prepareSandboxContextForPrompt({
              sandboxManager,
              writer,
              eventId: `sandbox-fallback-${assistantMessageId}`,
              emitFallbackEvent: false,
              onContextError: (err) => {
                console.warn(
                  "[agent-long] Failed to get sandbox context:",
                  err,
                );
              },
            });
            const sandboxContext = sandboxPromptContext.sandboxContext;
            const sandboxFallbackReminder = getSandboxFallbackPromptReminder(
              sandboxPromptContext.fallbackInfo,
            );
            try {
              assertLocalSandboxFallbackAllowed({
                fallbackInfo: sandboxPromptContext.fallbackInfo,
              });
            } catch (error) {
              if (error instanceof ChatSDKError) {
                await usageRefundTracker.refund().catch(() => {});
                chatLogger?.emitChatError(error);
              }
              throw error;
            }
            if (sandboxPromptContext.fallbackInfo?.occurred) {
              writeSandboxFallbackEvent(
                writer,
                sandboxPromptContext.fallbackInfo,
                `sandbox-fallback-${assistantMessageId}`,
              );
            }

            if (sandboxFiles && sandboxFiles.length > 0) {
              writeUploadStartStatus(
                writer,
                sandboxFiles.every((file) => file.kind === "localPath")
                  ? "Preparing local attachments on your computer"
                  : "Uploading attachments to the computer",
              );
              let uploadResult: Awaited<ReturnType<typeof uploadSandboxFiles>> =
                {
                  failedCount: 0,
                  pathRewrites: [],
                };
              try {
                uploadResult = await uploadSandboxFiles(
                  sandboxFiles,
                  ensureSandbox,
                  {
                    retryWithFreshSandboxOnTransientFailure: () =>
                      uploadSandboxBootPath === "reuse_existing",
                  },
                );
              } finally {
                writeUploadCompleteStatus(writer);
              }
              if (uploadResult.failedCount > 0) {
                const noun =
                  uploadResult.failedCount === 1 ? "attachment" : "attachments";
                const uploadError = new ChatSDKError(
                  "bad_request:stream",
                  `Failed to upload ${uploadResult.failedCount} ${noun} to the computer. Please try again.`,
                  getSandboxUploadFailureMetadata(uploadResult),
                );
                await usageRefundTracker.refund();
                chatLogger?.emitChatError(uploadError);
                throw uploadError;
              }
              processedMessages = rewriteSandboxFilePathsInMessages(
                processedMessages,
                uploadResult.pathRewrites,
              );
            }

            const titlePromise =
              isNewChat && !temporary
                ? generateTitleFromUserMessageWithWriter(
                    processedMessages,
                    writer,
                  )
                : Promise.resolve(undefined);

            const trackedProvider = createTrackedProvider();
            const currentSystemPrompt = await systemPrompt(
              userId,
              mode,
              subscription,
              selectedModel,
              userCustomization,
              temporary,
              sandboxContext,
              agentPermissionMode,
            );
            const systemPromptTokens = safeCountTokens(currentSystemPrompt);

            const contextUsageOn = isContextUsageEnabled(subscription, mode);
            const ctxSystemTokens = contextUsageOn ? systemPromptTokens : 0;
            const ctxMaxTokens = contextUsageOn
              ? getMaxTokensForSubscription(subscription, { mode })
              : 0;
            const initialCtxUsage = contextUsageOn
              ? computeContextUsage(
                  messagesForAccounting,
                  fileTokens,
                  ctxSystemTokens,
                  ctxMaxTokens,
                )
              : { usedTokens: 0, maxTokens: 0 };

            let finalMessages = processedMessages;

            if (sandboxFallbackReminder) {
              finalMessages = appendSystemReminderToLastUserMessage(
                finalMessages,
                sandboxFallbackReminder,
              );
            }

            const resumeContext = regenerate
              ? ""
              : getResumeSection(chat?.finish_reason);
            if (resumeContext) {
              finalMessages = appendSystemReminderToLastUserMessage(
                finalMessages,
                resumeContext,
              );
            }

            const noteInjectionOpts = {
              userId,
              subscription,
              shouldIncludeNotes: userCustomization?.include_notes ?? true,
              isTemporary: !!temporary as boolean | undefined,
            };
            finalMessages = await injectNotesIntoMessages(
              finalMessages,
              noteInjectionOpts,
            );

            // Mutable stream state — updated in-place by the shared runner and
            // read back here in toUIMessageStream.onFinish.
            const state = initAgentStreamState(finalMessages, initialCtxUsage);
            terminalAgentState = state;

            const budgetSnapshot = captureBudgetSnapshot({
              rateLimitInfo,
              extraUsageConfig,
              subscription,
            });
            const effectiveBudgetSnapshot =
              budgetSnapshot ??
              (freeMonthlyBudgetSnapshot?.rateLimitSkipped
                ? null
                : freeMonthlyBudgetSnapshot);
            // Use task start time (not stream start time) so the soft stop
            // leaves cleanup grace before the plan-specific runtime cap.
            const streamStartTime = taskStartTime;
            const configuredModelId =
              trackedProvider.languageModel(selectedModel).modelId;
            const budgetMonitor = effectiveBudgetSnapshot
              ? new BudgetMonitor(
                  effectiveBudgetSnapshot,
                  writer,
                  subscription,
                  {
                    extraUsageConfig,
                  },
                )
              : null;

            let isRetryWithFallback = false;
            const isAutoModel = [
              "ask-model",
              "ask-model-free",
              "agent-model",
              "agent-model-free",
            ].includes(selectedModel);
            const fallbackModel = getRetryFallbackModel(selectedModel, mode);
            const fallbackModelId =
              trackedProvider.languageModel(fallbackModel).modelId;
            let activeModelName = selectedModel;

            const usageTracker = new UsageTracker();
            observedUsageTracker = usageTracker;
            let hasRecordedUsage = false;
            let preFallbackCacheRead = 0;
            let preFallbackCacheWrite = 0;
            const usageSettlementState =
              subscription === "free"
                ? null
                : createUsageSettlementState(rateLimitInfo, extraUsageConfig);

            const deductAccumulatedUsage = async () => {
              try {
                if (hasRecordedUsage) return;
                const sandboxCost = getSandboxSessionCost();
                if (sandboxCost > 0) {
                  usageTracker.providerCost += sandboxCost;
                  usageTracker.nonModelCost += sandboxCost;
                  chatLogger?.getBuilder().addToolCost(sandboxCost);
                }
                if (!usageTracker.hasUsage) return;
                hasRecordedUsage = true;
                const usageRecordArgs = {
                  selectedModel,
                  selectedModelOverride,
                  responseModel: state.responseModel,
                  configuredModelId,
                  accountingModel: resolveServedModelForCostAccounting({
                    modelName: activeModelName,
                    responseModel: state.responseModel,
                    mode,
                  }),
                  rateLimitInfo,
                };
                let usageCostRecord =
                  usageTracker.createUsageCostRecord(usageRecordArgs);
                const providerCost = usageTracker.hasAuthoritativeModelCost
                  ? usageTracker.providerCost
                  : undefined;
                if (subscription === "free") {
                  await recordFreeMonthlyCost(
                    freeUsageSubject,
                    usageCostRecord.costDollars,
                  );
                } else {
                  const deductionResult = await deductUsage(
                    userId,
                    subscription,
                    estimatedInputTokens,
                    usageTracker.inputTokens,
                    usageTracker.outputTokens,
                    extraUsageConfig,
                    providerCost,
                    selectedModel,
                    usageTracker.nonModelCost,
                    organizationId,
                    usageSettlementState
                      ? getUsageSettlementInitialDeduction(usageSettlementState)
                      : rateLimitInfo,
                    usageRecordArgs.accountingModel,
                  );
                  if (usageSettlementState) {
                    usageRefundTracker.recordDeductions({
                      ...rateLimitInfo,
                      pointsDeducted: deductionResult.includedPointsDeducted,
                      extraUsagePointsDeducted:
                        deductionResult.extraUsagePointsDeducted,
                    });
                    replaceUsageSettlementState(
                      usageSettlementState,
                      deductionResult,
                    );
                  }
                  if (deductionResult.uncoveredPoints > 0) {
                    state.stoppedDueToBudgetExhaustion = true;
                    if (state.streamFinishReason !== "error") {
                      state.streamFinishReason =
                        BUDGET_EXHAUSTION_FINISH_REASON;
                    }
                    phLogger.warn("Usage deduction left uncovered cost", {
                      chatId,
                      endpoint,
                      mode,
                      userId,
                      organizationId,
                      subscription,
                      selectedModel,
                      uncoveredPoints: deductionResult.uncoveredPoints,
                      usageDeductionFailureReason:
                        deductionResult.usageDeductionFailureReason,
                    });
                  }
                  const billingBreakdown =
                    deductionResult.includedPointsDeducted > 0 ||
                    deductionResult.extraUsagePointsDeducted > 0 ||
                    deductionResult.uncoveredPoints > 0 ||
                    deductionResult.usageDeductionFailed ||
                    !!deductionResult.usageDeductionFailureReason
                      ? deductionResult
                      : undefined;
                  usageCostRecord = usageTracker.createUsageCostRecord({
                    ...usageRecordArgs,
                    billingBreakdown,
                  });
                  usageTracker.log({
                    userId,
                    organizationId,
                    chatId,
                    endpoint,
                    mode,
                    subscription,
                    selectedModel,
                    selectedModelOverride,
                    responseModel: state.responseModel,
                    configuredModelId,
                    accountingModel: usageRecordArgs.accountingModel,
                    rateLimitInfo,
                    billingBreakdown,
                  });
                }
                captureUsageCost({
                  posthog,
                  userId,
                  subscription,
                  organizationId,
                  chatId,
                  endpoint,
                  mode,
                  usage: usageCostRecord,
                });
              } finally {
                await releaseFreeRunLockOnce();
              }
            };

            const settleUsageAfterStep: AgentStreamContext["settleUsageAfterStep"] =
              async ({ currentCostDollars, force }) => {
                if (!usageSettlementState || hasRecordedUsage) return;
                if (
                  !shouldSettleUsageMidRun({
                    state: usageSettlementState,
                    currentCostDollars,
                    force,
                  })
                ) {
                  return;
                }

                const additionalCostPoints = getUnsettledUsagePoints(
                  usageSettlementState,
                  currentCostDollars,
                );
                if (additionalCostPoints <= 0) return;

                let deductionResult: Awaited<
                  ReturnType<typeof deductUsageDelta>
                >;
                try {
                  deductionResult = await deductUsageDelta(
                    userId,
                    subscription,
                    additionalCostPoints,
                    extraUsageConfig,
                    organizationId,
                  );
                } catch (error) {
                  phLogger.warn("Mid-run usage settlement failed", {
                    event: "mid_run_usage_settlement_failed",
                    chat_id: chatId,
                    endpoint: "/api/agent-long",
                    mode,
                    user_id: userId,
                    organization_id: organizationId,
                    subscription,
                    selected_model: selectedModel,
                    additional_cost_points: additionalCostPoints,
                    current_cost_dollars: currentCostDollars,
                    force,
                    error:
                      error instanceof Error ? error.message : String(error),
                  });
                  deductionResult = {
                    includedPointsDeducted: 0,
                    extraUsagePointsDeducted: 0,
                    uncoveredPoints: additionalCostPoints,
                    usageDeductionFailed: true,
                    usageDeductionFailureReason: "deduction_failed",
                  };
                }

                usageRefundTracker.addDeductions(deductionResult);
                const cumulativeDeduction = addUsageDeductionDelta(
                  usageSettlementState,
                  deductionResult,
                );
                if (cumulativeDeduction.uncoveredPoints <= 0) return;

                state.stoppedDueToBudgetExhaustion = true;
                if (state.streamFinishReason !== "error") {
                  state.streamFinishReason = BUDGET_EXHAUSTION_FINISH_REASON;
                }
                phLogger.warn("Mid-run usage settlement left uncovered cost", {
                  event: "mid_run_usage_settlement_uncovered",
                  chat_id: chatId,
                  endpoint: "/api/agent-long",
                  mode,
                  user_id: userId,
                  organization_id: organizationId,
                  subscription,
                  selected_model: selectedModel,
                  additional_cost_points: additionalCostPoints,
                  current_cost_dollars: currentCostDollars,
                  included_points_deducted:
                    cumulativeDeduction.includedPointsDeducted,
                  extra_usage_points_deducted:
                    cumulativeDeduction.extraUsagePointsDeducted,
                  uncovered_points: cumulativeDeduction.uncoveredPoints,
                  usage_deduction_failure_reason:
                    cumulativeDeduction.usageDeductionFailureReason,
                  force,
                });
                userStopSignal.abort();
              };

            // Shared runner context — immutable deps + platform hook.
            const streamCtx: AgentStreamContext = {
              trackedProvider,
              currentSystemPrompt,
              tools,
              mode,
              endpoint,
              userId,
              subscription,
              chatId,
              temporary,
              fileTokens,
              noteInjectionOpts,
              systemPromptTokens,
              ctxSystemTokens,
              ctxMaxTokens,
              streamStartTime,
              contextUsageOn,
              isReasoningModel: true, // long mode is always agent mode
              maxDurationMs: agentLongMaxDurationMs,
              writer,
              abortController: userStopSignal,
              summarizationTracker,
              usageTracker,
              budgetMonitor,
              sandboxManager,
              getTodoManager,
              ensureSandbox,
              chatLogger,
              usageRefundTracker,
              settleUsageAfterStep,
              onBudgetAbort: (details) =>
                captureAgentBudgetAbort({
                  posthog,
                  userId,
                  subscription,
                  chatId,
                  endpoint,
                  mode,
                  selectedModel,
                  selectedModelOverride,
                  configuredModelId,
                  responseModel: state.responseModel,
                  isAutoContinue,
                  details,
                }),
              getHardTimeoutReason: () =>
                agentLongDurationExceeded
                  ? PREEMPTIVE_TIMEOUT_FINISH_REASON
                  : null,
            };

            const createStream = (modelName: string) => {
              activeModelName = modelName;
              streamCtx.tools = getToolsForModel(modelName);
              setCurrentModelName(modelName);
              return createAgentStream(modelName, streamCtx, state);
            };

            let result;
            try {
              result = await createStream(selectedModel);
            } catch (error) {
              if (
                isProviderApiError(error) &&
                !isRetryWithFallback &&
                isAutoModel
              ) {
                phLogger.error(
                  "[agent-long] Provider API error, retrying with fallback",
                  {
                    error,
                    chatId,
                    originalModel: selectedModel,
                    requestedModelSlug: configuredModelId,
                    fallbackModel,
                    fallbackModelSlug: fallbackModelId,
                    userId,
                    subscription,
                    preFallbackCacheReadTokens: usageTracker.cacheReadTokens,
                    preFallbackCacheWriteTokens: usageTracker.cacheWriteTokens,
                    ...extractErrorDetails(error),
                  },
                );
                isRetryWithFallback = true;
                state.lastStepInputTokens = 0;
                state.stoppedDueToTokenExhaustion = false;
                state.stoppedDueToElapsedTimeout = false;
                state.stoppedDueToDoomLoop = false;
                state.stoppedDueToAssistantContentLoop = false;
                state.assistantContentLoopDetection = undefined;
                state.stoppedDueToBudgetExhaustion = false;
                state.stoppedDueToAgentRunSpendCap = false;
                state.stoppedDueToPostSummarizationIncomplete = false;
                state.postSummarizationContinuationActive = false;
                state.postSummarizationToolCallCount = 0;
                state.postSummarizationText = "";
                state.budgetAbortDetails = undefined;
                preFallbackCacheRead = usageTracker.cacheReadTokens;
                preFallbackCacheWrite = usageTracker.cacheWriteTokens;
                usageTracker.resetModelLeg();
                result = await createStream(fallbackModel);
              } else {
                throw error;
              }
            }

            writer.merge(
              withAgentLongStreamHeartbeat(
                result.toUIMessageStream({
                  generateMessageId: () => assistantMessageId,
                  sendReasoning: true,
                  messageMetadata: ({ part }) => {
                    if (part.type === "start") {
                      return {
                        mode,
                        createdAt: streamStartTime,
                        generationStartedAt: streamStartTime,
                      };
                    }

                    if (part.type === "finish") {
                      return {
                        mode,
                        createdAt: streamStartTime,
                        generationStartedAt: streamStartTime,
                        generationTimeMs: Date.now() - streamStartTime,
                      };
                    }
                  },
                  onFinish: async ({
                    messages: finishedMessages,
                    isAborted,
                  }) => {
                    let retryScheduled = false;
                    try {
                      // Retry with fallback if the primary stream failed before
                      // producing text, tool calls, or tool output worth saving.
                      const lastAssistantMessage = finishedMessages
                        .slice()
                        .reverse()
                        .find((m) => m.role === "assistant");
                      const lastAssistantMessageParts =
                        stripAgentLongHeartbeatParts(
                          lastAssistantMessage ?? { parts: [] },
                        ).parts ?? [];
                      const assistantContentLoopDetection =
                        state.assistantContentLoopDetection ??
                        (isAborted
                          ? { detected: false as const }
                          : detectAssistantContentLoopFromParts(
                              lastAssistantMessageParts,
                            ));
                      const stoppedDueToAssistantContentLoop =
                        state.stoppedDueToAssistantContentLoop ||
                        (!isAborted && assistantContentLoopDetection.detected);
                      const hasTerminalProviderStreamError =
                        isTerminalProviderStreamError(state);
                      const shouldRetryInterruptedToolInput =
                        shouldRetryProviderStreamAfterInterruptedToolInput(
                          lastAssistantMessageParts,
                          { hasTerminalProviderStreamError },
                        );
                      const shouldRetryWithFallback =
                        shouldRetryAgentLongWithFallback(
                          lastAssistantMessageParts,
                          {
                            hasTerminalProviderStreamError:
                              hasTerminalProviderStreamError,
                            stoppedDueToDoomLoop: state.stoppedDueToDoomLoop,
                            stoppedDueToAssistantContentLoop,
                            detectAssistantContentLoop: !isAborted,
                          },
                        );
                      const imageRecovery =
                        state.providerRejectedMultimodalToolResults
                          ? omitImageViewToolResultsForProviderRetry(
                              finishedMessages,
                            )
                          : { messages: finishedMessages, omittedCount: 0 };
                      const shouldRetryWithoutImageToolResults =
                        imageRecovery.omittedCount > 0 && !isAborted;

                      if (
                        (shouldRetryWithFallback ||
                          shouldRetryWithoutImageToolResults) &&
                        !isRetryWithFallback &&
                        (!isAborted || stoppedDueToAssistantContentLoop) &&
                        (isAutoModel ||
                          shouldRetryWithoutImageToolResults ||
                          stoppedDueToAssistantContentLoop ||
                          state.stoppedDueToDoomLoop ||
                          shouldRetryInterruptedToolInput)
                      ) {
                        const retryReason = shouldRetryWithoutImageToolResults
                          ? "image_tool_result_rejection"
                          : stoppedDueToAssistantContentLoop
                            ? "assistant_content_loop"
                            : state.stoppedDueToDoomLoop
                              ? "doom_loop"
                              : shouldRetryInterruptedToolInput
                                ? "interrupted_tool_input"
                                : "incomplete_stream";
                        phLogger.warn(
                          "[agent-long] Provider output triggered fallback retry",
                          {
                            chatId,
                            mode,
                            originalModel: selectedModel,
                            requestedModelSlug: configuredModelId,
                            fallbackModel,
                            fallbackModelSlug: fallbackModelId,
                            userId,
                            subscription,
                            retryReason,
                            isAborted,
                            stoppedDueToDoomLoop: state.stoppedDueToDoomLoop,
                            assistantContentLoop:
                              assistantContentLoopDetection.detected
                                ? assistantContentLoopDetection
                                : undefined,
                            shouldRetryInterruptedToolInput,
                            imageToolResultsOmitted: imageRecovery.omittedCount,
                          },
                        );
                        isRetryWithFallback = true;
                        state.lastStepInputTokens = 0;
                        state.streamFinishReason = undefined;
                        state.providerError = undefined;
                        state.providerRejectedMultimodalToolResults = false;
                        state.stoppedDueToTokenExhaustion = false;
                        state.stoppedDueToElapsedTimeout = false;
                        state.stoppedDueToDoomLoop = false;
                        state.stoppedDueToAssistantContentLoop = false;
                        state.assistantContentLoopDetection = undefined;
                        state.stoppedDueToBudgetExhaustion = false;
                        state.stoppedDueToAgentRunSpendCap = false;
                        state.stoppedDueToPostSummarizationIncomplete = false;
                        state.postSummarizationContinuationActive = false;
                        state.postSummarizationToolCallCount = 0;
                        state.postSummarizationText = "";
                        state.budgetAbortDetails = undefined;
                        const fallbackStartTime = Date.now();
                        preFallbackCacheRead = usageTracker.cacheReadTokens;
                        preFallbackCacheWrite = usageTracker.cacheWriteTokens;
                        const retryModel = shouldRetryWithoutImageToolResults
                          ? selectedModel
                          : fallbackModel;
                        if (shouldRetryWithoutImageToolResults) {
                          const normalizedRetryMessages = imageRecovery.messages
                            .map((message) =>
                              message.role === "assistant"
                                ? stripAgentLongHeartbeatParts(message)
                                : message,
                            )
                            .filter(
                              (message) =>
                                message.role !== "assistant" ||
                                (message.parts?.length ?? 0) > 0,
                            );
                          state.finalMessages =
                            omitTrailingStepStartAssistantMessage(
                              normalizedRetryMessages,
                            );
                        } else {
                          usageTracker.resetModelLeg();
                        }
                        const retryResult = await createStream(retryModel);
                        const retryMessageId = generateId();

                        writer.merge(
                          withAgentLongStreamHeartbeat(
                            retryResult.toUIMessageStream({
                              generateMessageId: () => retryMessageId,
                              sendReasoning: true,
                              messageMetadata: ({ part }) => {
                                if (part.type === "start") {
                                  return {
                                    mode,
                                    createdAt: fallbackStartTime,
                                    generationStartedAt: fallbackStartTime,
                                  };
                                }

                                if (part.type === "finish") {
                                  return {
                                    mode,
                                    createdAt: fallbackStartTime,
                                    generationStartedAt: fallbackStartTime,
                                    generationTimeMs:
                                      Date.now() - fallbackStartTime,
                                  };
                                }
                              },
                              onFinish: async ({
                                messages: retryMessages,
                                isAborted: retryAborted,
                              }) => {
                                try {
                                  const fallbackCacheRead =
                                    usageTracker.cacheReadTokens -
                                    preFallbackCacheRead;
                                  const fallbackCacheWrite =
                                    usageTracker.cacheWriteTokens -
                                    preFallbackCacheWrite;
                                  const fallbackCacheTotal =
                                    fallbackCacheRead + fallbackCacheWrite;
                                  const sandboxInfo =
                                    sandboxManager.getSandboxInfo();
                                  chatLogger?.setSandbox(sandboxInfo);
                                  chatLogger?.setCacheMetrics({
                                    cacheHitRate:
                                      fallbackCacheTotal > 0
                                        ? fallbackCacheRead / fallbackCacheTotal
                                        : null,
                                    cacheReadTokens: fallbackCacheRead,
                                    cacheWriteTokens: fallbackCacheWrite,
                                  });
                                  captureToolCalls({
                                    posthog,
                                    chatLogger,
                                    userId,
                                    mode,
                                  });
                                  // Final reconciliation can change the finish
                                  // reason to budget-exhausted; do it before
                                  // analytics and persistence consume state.
                                  await deductAccumulatedUsage();
                                  const outcome = retryAborted
                                    ? "aborted"
                                    : isTerminalProviderStreamError(state)
                                      ? "error"
                                      : "success";
                                  captureAgentCompletionAnalytics({
                                    posthog,
                                    writer,
                                    userId,
                                    chatId,
                                    endpoint,
                                    mode,
                                    subscription,
                                    sandboxInfo,
                                    outcome,
                                    chatLogger,
                                    finishReason: state.streamFinishReason,
                                    budgetAbortDetails:
                                      state.budgetAbortDetails,
                                  });
                                  if (!isTerminalProviderStreamError(state)) {
                                    chatLogger?.emitSuccess({
                                      finishReason: state.streamFinishReason,
                                      wasAborted: retryAborted,
                                      wasPreemptiveTimeout: false,
                                      hadSummarization:
                                        summarizationTracker.hasSummarized,
                                    });
                                  }

                                  const generatedTitle = await titlePromise;
                                  if (!temporary) {
                                    const mergedTodos =
                                      getTodoManager().mergeWith(
                                        baseTodos,
                                        retryMessageId,
                                      );
                                    if (
                                      generatedTitle ||
                                      state.streamFinishReason ||
                                      mergedTodos.length > 0
                                    ) {
                                      await updateChat({
                                        chatId,
                                        title: generatedTitle,
                                        finishReason: state.streamFinishReason,
                                        todos: mergedTodos,
                                        defaultModelSlug: "agent",
                                        sandboxType:
                                          sandboxManager.getEffectivePreference(),
                                        selectedModel: selectedModelOverride,
                                      });
                                    } else {
                                      await prepareForNewStream({ chatId });
                                    }
                                    const accumulatedFiles =
                                      getFileAccumulator().getAll();
                                    const newFileIds = accumulatedFiles.map(
                                      (f) => f.fileId,
                                    );
                                    const fallbackGenerationTimeMs =
                                      Date.now() - fallbackStartTime;
                                    for (const msg of retryMessages) {
                                      if (msg.role !== "assistant") continue;
                                      const processed =
                                        stripAgentLongHeartbeatParts(
                                          summarizationTracker.processMessageForSave(
                                            msg,
                                          ),
                                        );
                                      await saveMessage({
                                        chatId,
                                        userId,
                                        message: processed,
                                        extraFileIds: newFileIds,
                                        usage: state.streamUsage,
                                        model: state.responseModel,
                                        mode,
                                        generationStartedAt: fallbackStartTime,
                                        generationTimeMs:
                                          fallbackGenerationTimeMs,
                                        finishReason: state.streamFinishReason,
                                      });
                                    }
                                    writer.write({
                                      type: "message-metadata",
                                      messageMetadata: {
                                        mode,
                                        createdAt: fallbackStartTime,
                                        generationStartedAt: fallbackStartTime,
                                        generationTimeMs:
                                          fallbackGenerationTimeMs,
                                      },
                                    });
                                    sendFileMetadataToStream(accumulatedFiles);
                                  }
                                  posthog?.shutdown();
                                } finally {
                                  await releaseFreeRunLockOnce();
                                }
                              },
                            }),
                            userStopSignal.signal,
                          ),
                        );
                        retryScheduled = true;
                        return;
                      }

                      // User-initiated cancel via trigger.dev: clear finish reason
                      // so the client doesn't show spurious "going off course" messages.
                      if (
                        isAborted &&
                        triggerSignal.aborted &&
                        !state.stoppedDueToBudgetExhaustion &&
                        !state.stoppedDueToElapsedTimeout
                      ) {
                        state.streamFinishReason = undefined;
                      }

                      const sandboxInfo = sandboxManager.getSandboxInfo();
                      chatLogger?.setSandbox(sandboxInfo);
                      chatLogger?.setCacheMetrics({
                        cacheHitRate: usageTracker.cacheHitRate,
                        cacheReadTokens: usageTracker.cacheReadTokens,
                        cacheWriteTokens: usageTracker.cacheWriteTokens,
                      });
                      captureToolCalls({ posthog, chatLogger, userId, mode });
                      // Final reconciliation can change the finish reason to
                      // budget-exhausted; do it before analytics and
                      // persistence consume state.
                      await deductAccumulatedUsage();
                      const outcome = isAborted
                        ? "aborted"
                        : isTerminalProviderStreamError(state)
                          ? "error"
                          : "success";
                      captureAgentCompletionAnalytics({
                        posthog,
                        writer,
                        userId,
                        chatId,
                        endpoint,
                        mode,
                        subscription,
                        sandboxInfo,
                        outcome,
                        chatLogger,
                        finishReason: state.streamFinishReason,
                        budgetAbortDetails: state.budgetAbortDetails,
                      });
                      if (!isTerminalProviderStreamError(state)) {
                        chatLogger?.emitSuccess({
                          finishReason: state.streamFinishReason,
                          wasAborted: isAborted,
                          wasPreemptiveTimeout:
                            state.stoppedDueToElapsedTimeout,
                          hadSummarization: summarizationTracker.hasSummarized,
                        });
                      }

                      const generatedTitle = await titlePromise;

                      if (!temporary) {
                        const mergedTodos = getTodoManager().mergeWith(
                          baseTodos,
                          assistantMessageId,
                        );
                        const shouldPersist = regenerate
                          ? true
                          : Boolean(
                              generatedTitle ||
                              state.streamFinishReason ||
                              mergedTodos.length > 0,
                            );

                        if (shouldPersist) {
                          await updateChat({
                            chatId,
                            title: generatedTitle,
                            finishReason: state.streamFinishReason,
                            todos: mergedTodos,
                            defaultModelSlug: "agent",
                            sandboxType:
                              sandboxManager.getEffectivePreference(),
                            selectedModel: selectedModelOverride,
                          });
                        } else {
                          await prepareForNewStream({ chatId });
                        }

                        const accumulatedFiles = getFileAccumulator().getAll();
                        const newFileIds = accumulatedFiles.map(
                          (f) => f.fileId,
                        );

                        let resolvedUsage: Record<string, unknown> | undefined =
                          state.streamUsage;
                        if (!resolvedUsage && isAborted) {
                          try {
                            resolvedUsage = (await result.usage) as Record<
                              string,
                              unknown
                            >;
                          } catch {
                            // Usage unavailable on abort
                          }
                        }

                        const hasIncompleteToolCalls = finishedMessages.some(
                          (msg) =>
                            msg.role === "assistant" &&
                            msg.parts?.some(
                              (p: {
                                type?: string;
                                state?: string;
                                toolCallId?: string;
                              }) =>
                                p.type?.startsWith("tool-") &&
                                p.state !== "output-available" &&
                                p.toolCallId,
                            ),
                        );
                        const incompleteToolSummaries = isAborted
                          ? summarizeIncompleteToolParts(finishedMessages)
                          : [];
                        if (incompleteToolSummaries.length > 0) {
                          console.info(
                            JSON.stringify({
                              level: "info",
                              event:
                                "agent_long_abort_incomplete_tool_calls_detected",
                              service: "agent-long",
                              timestamp: new Date().toISOString(),
                              chat_id: chatId,
                              user_id: userId,
                              mode: "agent",
                              finish_reason: state.streamFinishReason,
                              trigger_signal_aborted: triggerSignal.aborted,
                              incomplete_tool_count:
                                incompleteToolSummaries.length,
                              incomplete_tools: incompleteToolSummaries,
                            }),
                          );
                        }
                        const hasAssistantContentToSave =
                          hasVisibleAssistantContent(finishedMessages);
                        if (
                          shouldSkipAbortedMessageSave({
                            isAborted,
                            shouldSkipSaveSignal: false,
                            hasVisibleAssistantContent:
                              hasAssistantContentToSave,
                            hasNewFiles: newFileIds.length > 0,
                            hasIncompleteToolCalls,
                            hasUsageToRecord: Boolean(resolvedUsage),
                          })
                        ) {
                          console.info(
                            JSON.stringify({
                              level: "info",
                              event: "agent_long_abort_message_save_skipped",
                              service: "agent-long",
                              timestamp: new Date().toISOString(),
                              chat_id: chatId,
                              user_id: userId,
                              mode: "agent",
                              finish_reason: state.streamFinishReason,
                              new_file_count: newFileIds.length,
                              has_visible_assistant_content:
                                hasAssistantContentToSave,
                              has_incomplete_tool_calls: hasIncompleteToolCalls,
                              has_usage_to_record: Boolean(resolvedUsage),
                            }),
                          );
                          await deductAccumulatedUsage();
                          posthog?.shutdown();
                          return;
                        }

                        const finalGenerationTimeMs =
                          Date.now() - streamStartTime;
                        let savedAssistantMessage = false;
                        const isUserInitiatedAbort =
                          isAborted &&
                          triggerSignal.aborted &&
                          !state.stoppedDueToBudgetExhaustion &&
                          !state.stoppedDueToAgentRunSpendCap &&
                          !state.stoppedDueToElapsedTimeout;
                        for (const message of finishedMessages) {
                          const processed = stripAgentLongHeartbeatParts(
                            summarizationTracker.processMessageForSave(message),
                          );
                          if (
                            (!processed.parts ||
                              processed.parts.length === 0) &&
                            newFileIds.length === 0
                          ) {
                            continue;
                          }
                          await saveMessage({
                            chatId,
                            userId,
                            message: processed,
                            extraFileIds: newFileIds,
                            model: state.responseModel || configuredModelId,
                            mode,
                            generationStartedAt:
                              processed.role === "assistant"
                                ? streamStartTime
                                : undefined,
                            generationTimeMs: finalGenerationTimeMs,
                            finishReason: state.streamFinishReason,
                            usage: resolvedUsage ?? state.streamUsage,
                            updateOnly: shouldUseUpdateOnlyForAbortedSave({
                              isAborted,
                              isUserInitiatedAbort,
                            })
                              ? true
                              : undefined,
                            isHidden:
                              isAutoContinue && processed.role === "user"
                                ? true
                                : undefined,
                          });
                          if (processed.role === "assistant") {
                            savedAssistantMessage = true;
                          }
                        }

                        if (savedAssistantMessage) {
                          writer.write({
                            type: "message-metadata",
                            messageMetadata: {
                              mode,
                              createdAt: streamStartTime,
                              generationStartedAt: streamStartTime,
                              generationTimeMs: finalGenerationTimeMs,
                            },
                          });
                        }

                        sendFileMetadataToStream(accumulatedFiles);
                      }

                      // Don't auto-continue on elapsed timeout. Runs that hit
                      // their plan cap are large enough that the user should
                      // explicitly decide whether to continue.
                      if (
                        (state.stoppedDueToTokenExhaustion ||
                          state.stoppedDueToPostSummarizationIncomplete ||
                          state.streamFinishReason === "tool-calls") &&
                        !temporary
                      ) {
                        writeAutoContinue(writer);
                      }
                      posthog?.shutdown();
                    } finally {
                      if (!retryScheduled) {
                        await releaseFreeRunLockOnce();
                      }
                    }
                  },
                }),
                userStopSignal.signal,
              ),
            );
          } catch (error) {
            await releaseFreeRunLockOnce();
            throw error;
          }
        },
      });

      metadata
        .set("status", "streaming")
        .set("model", selectedModel)
        .set("setupBeforeStreamMs", Date.now() - taskStartTime);
      const { waitUntilComplete } = agentUiStream.pipe(uiStream);
      streamPiped = true;
      try {
        await waitUntilComplete();
      } catch (error) {
        if (!isTriggerRealtimeTransportError(error)) {
          throw error;
        }

        const details = extractErrorDetails(error);
        const errorMessage = truncateForTriggerMetadata(
          typeof details.errorMessage === "string"
            ? details.errorMessage
            : "Trigger realtime stream transport failed",
        );

        metadata
          .set("realtimeStreamStatus", "transport_error")
          .set("realtimeStreamErrorMessage", errorMessage)
          .set("realtimeStreamFailedAt", new Date().toISOString());
        await tags.add("trigger_realtime_transport_error");
        triggerLogger.warn("[agent-long] realtime stream transport failed", {
          chatId,
          userId,
          runId: ctx.run.id,
          errorName:
            error instanceof Error ? error.name : getErrorField(error, "name"),
          errorCode: getErrorField(error, "code"),
          errorMessage,
        });
        phLogger.warn("Trigger realtime stream transport failed", {
          event: "trigger_realtime_transport_error",
          chatId,
          userId,
          runId: ctx.run.id,
          error,
        });
      }

      const terminalStreamError =
        streamError ?? getTerminalProviderStreamError(terminalAgentState);
      if (terminalStreamError) {
        if (isHandledUserRateLimitError(terminalStreamError)) {
          await recordAgentLongHandledRateLimitForDashboard(
            terminalStreamError,
            {
              chatId,
              userId,
              runId: ctx.run.id,
            },
          ).catch((metadataError) => {
            metadata.set("status", "rate_limited");
            console.error(
              "[agent-long] failed to record rate limit metadata:",
              metadataError,
            );
          });
          await usageRefundTracker.refund().catch(() => {});
          chatLogger?.emitChatError(terminalStreamError);
          await phLogger.flush().catch(() => {});
          return { chatId, assistantMessageId };
        }
        throw terminalStreamError;
      }

      metadata.set("status", "done");
      await phLogger.flush().catch(() => {});
    } catch (error) {
      await releaseFreeRunLockOnce();
      const chatMissingAfterStream =
        streamPiped &&
        error instanceof ChatSDKError &&
        isChatNotFoundError(error);
      const caughtErrorSummary = classifyAgentLongError(error);
      const caughtErrorUserCorrectable =
        isUserCorrectableAgentLongErrorCategory(caughtErrorSummary.category);
      const recordedFailure = await recordAgentLongFailureForDashboard(error, {
        chatId,
        userId,
        runId: ctx.run.id,
        phase: streamPiped ? "streaming" : "setup",
      }).catch((metadataError): RecordedAgentLongFailure => {
        metadata
          .set(
            "status",
            getAgentLongErrorRunStatus(caughtErrorSummary.category),
          )
          .set("errorCategory", caughtErrorSummary.category);
        if (caughtErrorUserCorrectable) {
          metadata.set("userCorrectable", true);
        }
        console.error(
          "[agent-long] failed to record run error metadata:",
          metadataError,
        );
        return { userCorrectable: caughtErrorUserCorrectable };
      });
      if (!hasObservedUsage()) {
        await usageRefundTracker.refund().catch(() => {});
      }
      if (error instanceof ChatSDKError) {
        chatLogger?.emitChatError(error);
      } else {
        chatLogger?.emitUnexpectedError(error);
      }
      await ptySessionManager
        .closeAll(chatId)
        .catch((err) =>
          console.error("[agent-long] PTY closeAll (outer catch) failed:", err),
        );

      // Pre-stream setup failed (DB fetch, message processing, etc.). Emit a
      // one-shot UI stream whose onError converts the caught error into the
      // same friendly error chunk format useChat expects. Without this, the
      // frontend transport only sees the run go to FAILED and emits a silent
      // abort, leaving the user stuck on a Stop button with no message.
      let userVisibleErrorStreamFlushed = streamPiped;
      if (!streamPiped) {
        try {
          const errorStream = createUIMessageStream({
            onError: (err) => {
              if (err instanceof ChatSDKError) {
                return typeof err.cause === "string" ? err.cause : err.message;
              }
              return getUserFriendlyProviderError(err);
            },
            execute: async () => {
              throw error;
            },
          });
          const { waitUntilComplete: waitForErrorStream } =
            agentUiStream.pipe(errorStream);
          await waitForErrorStream();
          userVisibleErrorStreamFlushed = true;
        } catch (pipeErr) {
          console.error(
            "[agent-long] Failed to emit synthetic error stream:",
            pipeErr,
          );
        }
      }

      await phLogger.flush().catch(() => {});
      if (
        (chatMissingAfterStream || recordedFailure.userCorrectable === true) &&
        userVisibleErrorStreamFlushed
      ) {
        return { chatId, assistantMessageId };
      }

      throw error;
    } finally {
      if (agentLongTimeout) clearTimeout(agentLongTimeout);
      runCleanupMap.delete(ctx.run.id);
      if (payload.approvalSessionId && triggerSessions) {
        try {
          await triggerSessions.close(payload.approvalSessionId, {
            reason: "agent-run-ended",
          });
        } catch (error) {
          console.error(
            "[agent-long] failed to close approval session:",
            error,
          );
        }
      }
      if (!payload.temporary) {
        try {
          await setActiveTriggerRun({
            chatId,
            triggerRunId: null,
            approvalSessionId: null,
            expectedRunId: ctx.run.id,
          });
        } catch (error) {
          console.error(
            "[agent-long] failed to clear active_trigger_run_id:",
            error,
          );
        }
      }
    }

    return { chatId, assistantMessageId };
  },
});
