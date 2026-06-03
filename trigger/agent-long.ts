import {
  task,
  tags,
  metadata,
  logger as triggerLogger,
} from "@trigger.dev/sdk";
import { agentUiStream } from "./streams";
import {
  createUIMessageStream,
  generateId,
  type UIMessageStreamWriter,
  UIMessage,
} from "ai";
import type { Geo } from "@vercel/functions";
import { countTokens } from "gpt-tokenizer";
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
  sendRateLimitWarnings,
  SummarizationTracker,
  appendSystemReminderToLastUserMessage,
  estimatePreflightInputTokens,
  buildExtraUsageConfig,
  computeContextUsage,
  writeContextUsage,
  isContextUsageEnabled,
  isProviderApiError,
  injectNotesIntoMessages,
  getRetryFallbackModel,
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
  recordFreeMonthlyCost,
  UsageRefundTracker,
} from "@/lib/rate-limit";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import {
  saveMessage,
  updateChat,
  getUserCustomization,
  setActiveTriggerRun,
  getMessagesByChatId,
  prepareForNewStream,
  setConvexUrl,
} from "@/lib/db/actions";
import { getMaxTokensForSubscription } from "@/lib/token-utils";
import { getBaseTodosForRequest } from "@/lib/utils/todo-utils";
import {
  writeAutoContinue,
  writeUploadStartStatus,
  writeUploadCompleteStatus,
} from "@/lib/utils/stream-writer-utils";
import {
  uploadSandboxFiles,
  getUploadBasePath,
  rewriteSandboxFilePathsInMessages,
} from "@/lib/utils/sandbox-file-utils";
import { getEmptyProcessedMessagesCause } from "@/lib/utils/local-attachment-messages";
import {
  captureAgentCompletionAnalytics,
  captureToolCalls,
  captureUsageCost,
  createChatLogger,
  type ChatLogger,
} from "@/lib/api/chat-logger";
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
  RateLimitInfo,
} from "@/types";
import {
  createAgentStream,
  initAgentStreamState,
  type AgentStreamContext,
  type AgentStreamState,
} from "@/lib/api/agent-stream-runner";
import {
  AGENT_LONG_HEARTBEAT_INTERVAL_MS,
  AGENT_LONG_HEARTBEAT_PART_TYPE,
  stripAgentLongHeartbeatParts,
} from "@/lib/chat/agent-long-heartbeat";
import { FREE_AGENT_LONG_RUN_LOCK_TTL_SECONDS } from "@/lib/rate-limit/free-config";

// Leave 2 min for cleanup before trigger.dev hits maxDuration: 60 * 60.
const AGENT_LONG_MAX_DURATION_MS = 58 * 60 * 1000;

type AgentLongUiStreamPart = Parameters<UIMessageStreamWriter["write"]>[0];

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

const getTerminalProviderStreamError = (
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

const isTerminalProviderStreamError = (
  state:
    | Pick<AgentStreamState, "streamFinishReason" | "providerError">
    | undefined,
): boolean => state?.streamFinishReason === "error";

const recordAgentLongFailureForDashboard = async (
  error: unknown,
  context: {
    chatId: string;
    userId: string;
    runId: string;
    phase: "setup" | "streaming";
  },
) => {
  const summary = classifyAgentLongError(error);
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
    chatId: context.chatId,
    userId: context.userId,
    runId: context.runId,
    phase: context.phase,
    ...summary,
  };
  if (summary.category === "chat_not_found") {
    triggerLogger.warn("[agent-long] run ended because chat is missing", {
      ...logFields,
      status: runStatus,
    });
  } else {
    triggerLogger.error("[agent-long] run failed", logFields);
  }

  await metadata.flush();
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
    `blocked_code_${sanitizeTriggerTagValue(summary.code ?? "rate_limit_chat")}`,
  ]);

  triggerLogger.info("[agent-long] run rate limited", {
    chatId: context.chatId,
    userId: context.userId,
    runId: context.runId,
    ...summary,
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

        safeEnqueue({
          type: AGENT_LONG_HEARTBEAT_PART_TYPE,
          data: { at: Date.now() },
        } as AgentLongUiStreamPart);
      }, AGENT_LONG_HEARTBEAT_INTERVAL_MS);

      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();

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
  messages: UIMessage[];
  localDesktopAttachmentsPrepared?: boolean;
  baseTodos: Todo[];
  sandboxPreference?: SandboxPreference;
  selectedModel?: SelectedModel;
  userLocation: Geo;
  temporary?: boolean;
  isAutoContinue?: boolean;
  regenerate?: boolean;
  isNewChat?: boolean;
  convexUrl?: string;
  requestTiming?: {
    routeStartedAt: number;
    triggerRequestedAt: number;
  };
};

export const agentLongTask = task({
  id: "agent-long",
  maxDuration: 60 * 60,
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
      messages,
      localDesktopAttachmentsPrepared,
      sandboxPreference,
      selectedModel: selectedModelOverride,
      userLocation,
      temporary,
      isAutoContinue,
      regenerate,
      isNewChat,
    } = payload;

    // Stable across retries so a failed-then-retried run upserts the same
    // message record rather than creating a duplicate.
    const assistantMessageId = ctx.run.id;
    const mode = "agent" as const;

    // Capture task start time here, before any async setup, so the
    // elapsedTimeExceeds stop condition counts from task launch rather
    // than stream launch. Without this, slow setup (>2 min) would cause
    // the 58-min stop to fire after trigger.dev's 60-min hard SIGKILL.
    const taskStartTime = Date.now();

    // Tag for dashboard filtering; add subscription tier for paid-only queries.
    await tags.add([`user_${userId}`, `chat_${chatId}`]);
    if (subscription !== "free") await tags.add(`sub_${subscription}`);

    // Lifecycle metadata so the dashboard shows progress for long runs.
    metadata
      .set("status", "setup")
      .set("chatId", chatId)
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
      endpoint: "/api/agent-long",
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
          allowLocalDesktopFiles: sandboxPreference === "desktop",
        });

      if (!processedMessages.length) {
        throw new ChatSDKError(
          "bad_request:api",
          getEmptyProcessedMessagesCause(messagesForProcessing),
        );
      }

      const memoryEnabled = userCustomization?.include_memory_entries ?? true;

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
          memoryEnabled,
        },
        selectedModel,
      );

      const posthog = PostHogClient();
      chatLogger.getBuilder().setAssistantId(assistantMessageId);

      // Wire trigger.dev's abort signal into a local controller.
      // Fires on runs.cancel() (UI Stop) and maxDuration exceeded.
      const userStopSignal = new AbortController();
      triggerSignal.addEventListener("abort", () => userStopSignal.abort(), {
        once: true,
      });

      const summarizationTracker = new SummarizationTracker();
      chatLogger.startStream();
      let terminalAgentState: AgentStreamState | undefined;

      // Rate limit check happens inside execute so a thrown ChatSDKError
      // (e.g. "exceeded daily messages") flows through createUIMessageStream's
      // onError → an error chunk on the UI stream → useChat renders the
      // friendly message. If we checked it outside, the task would throw
      // before agentUiStream.pipe() registered the stream, and the frontend
      // transport would only see a FAILED status with no error message.
      let rateLimitInfo: RateLimitInfo;
      let extraUsageConfig: Awaited<ReturnType<typeof buildExtraUsageConfig>>;

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
            await assertUserCanMakeCostIncurringRequest(userId);
            if (subscription === "free") {
              const lock = await acquireFreeRunConcurrencyLock(
                userId,
                FREE_AGENT_LONG_RUN_LOCK_TTL_SECONDS,
              );
              releaseFreeRunLock = lock.release;
            }

            extraUsageConfig = await buildExtraUsageConfig({
              userId,
              subscription,
              userCustomization,
              organizationId,
            });

            rateLimitInfo = await checkRateLimit(
              userId,
              mode,
              subscription,
              estimatedInputTokens,
              extraUsageConfig,
              selectedModel,
              organizationId,
            );

            const freeMonthlyBudgetSnapshot =
              subscription === "free"
                ? await checkFreeMonthlyCostLimit(userId)
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
              memoryEnabled,
              !!temporary,
              assistantMessageId,
              sandboxPreference,
              process.env.CONVEX_SERVICE_ROLE_KEY,
              userCustomization?.guardrails_config,
              false,
              undefined,
              undefined,
              (costDollars: number) => {
                usageTracker.providerCost += costDollars;
                usageTracker.nonModelCost += costDollars;
                chatLogger?.getBuilder().addToolCost(costDollars);
              },
              subscription,
              (info) => chatLogger?.setSandboxBoot(info),
              undefined,
              selectedModel,
            );

            const sendFileMetadataToStream = (
              fileMetadata: Array<{
                fileId: Id<"files">;
                name: string;
                mediaType: string;
                s3Key?: string;
                storageId?: Id<"_storage">;
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

            let sandboxContext: string | null = null;
            if ("getSandboxContextForPrompt" in sandboxManager) {
              try {
                sandboxContext = await (
                  sandboxManager as {
                    getSandboxContextForPrompt: () => Promise<string | null>;
                  }
                ).getSandboxContextForPrompt();
              } catch (err) {
                console.warn(
                  "[agent-long] Failed to get sandbox context:",
                  err,
                );
              }
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
            );
            const systemPromptTokens = countTokens(currentSystemPrompt);

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

            const resumeContext = getResumeSection(chat?.finish_reason);
            if (resumeContext) {
              finalMessages = appendSystemReminderToLastUserMessage(
                finalMessages,
                resumeContext,
              );
            }

            const noteInjectionOpts = {
              userId,
              subscription,
              shouldIncludeNotes:
                userCustomization?.include_memory_entries ?? true,
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
            const budgetMonitor = effectiveBudgetSnapshot
              ? new BudgetMonitor(effectiveBudgetSnapshot, writer, subscription)
              : null;

            // Use task start time (not stream start time) so the 58-min stop
            // condition always fires 2 min before the 60-min hard SIGKILL.
            const streamStartTime = taskStartTime;
            const configuredModelId =
              trackedProvider.languageModel(selectedModel).modelId;

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

            const usageTracker = new UsageTracker();
            observedUsageTracker = usageTracker;
            let hasRecordedUsage = false;
            let preFallbackCacheRead = 0;
            let preFallbackCacheWrite = 0;

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
                const usageCostRecord = usageTracker.createUsageCostRecord({
                  selectedModel,
                  selectedModelOverride,
                  responseModel: state.responseModel,
                  configuredModelId,
                  rateLimitInfo,
                });
                const providerCost =
                  usageTracker.modelProviderCost > 0
                    ? usageTracker.providerCost
                    : undefined;
                if (subscription === "free") {
                  await recordFreeMonthlyCost(
                    userId,
                    usageCostRecord.costDollars,
                  );
                } else {
                  await deductUsage(
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
                  );
                  usageTracker.log({
                    userId,
                    organizationId,
                    chatId,
                    endpoint: "/api/agent-long",
                    mode,
                    subscription,
                    selectedModel,
                    selectedModelOverride,
                    responseModel: state.responseModel,
                    configuredModelId,
                    rateLimitInfo,
                  });
                }
                captureUsageCost({
                  posthog,
                  userId,
                  subscription,
                  organizationId,
                  chatId,
                  endpoint: "/api/agent-long",
                  mode,
                  usage: usageCostRecord,
                });
              } finally {
                await releaseFreeRunLockOnce();
              }
            };

            // Shared runner context — immutable deps + platform hook.
            const streamCtx: AgentStreamContext = {
              trackedProvider,
              currentSystemPrompt,
              tools,
              mode,
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
              maxDurationMs: AGENT_LONG_MAX_DURATION_MS,
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
              // trigger.dev has no Vercel-style hard preemptive timeout
              getHardTimeoutReason: () => null,
            };

            const createStream = (modelName: string) => {
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
                state.stoppedDueToBudgetExhaustion = false;
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
                      // Retry with fallback if stream only produced step-start (incomplete response)
                      const lastAssistantMessage = finishedMessages
                        .slice()
                        .reverse()
                        .find((m) => m.role === "assistant");
                      const lastAssistantMessageParts =
                        stripAgentLongHeartbeatParts(
                          lastAssistantMessage ?? { parts: [] },
                        ).parts ?? [];
                      const hasOnlyStepStart =
                        lastAssistantMessageParts.length === 1 &&
                        (lastAssistantMessageParts[0] as { type?: string })
                          ?.type === "step-start";

                      if (
                        hasOnlyStepStart &&
                        !isRetryWithFallback &&
                        !isAborted &&
                        isAutoModel
                      ) {
                        isRetryWithFallback = true;
                        state.lastStepInputTokens = 0;
                        state.stoppedDueToTokenExhaustion = false;
                        state.stoppedDueToElapsedTimeout = false;
                        state.stoppedDueToDoomLoop = false;
                        state.stoppedDueToBudgetExhaustion = false;
                        const fallbackStartTime = Date.now();
                        preFallbackCacheRead = usageTracker.cacheReadTokens;
                        preFallbackCacheWrite = usageTracker.cacheWriteTokens;
                        usageTracker.resetModelLeg();
                        const retryResult = await createStream(fallbackModel);
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
                                  const outcome = retryAborted
                                    ? "aborted"
                                    : isTerminalProviderStreamError(state)
                                      ? "error"
                                      : "success";
                                  captureAgentCompletionAnalytics({
                                    posthog,
                                    userId,
                                    chatId,
                                    endpoint: "/api/agent-long",
                                    mode,
                                    subscription,
                                    sandboxInfo,
                                    outcome,
                                    chatLogger,
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
                                  await deductAccumulatedUsage();
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
                      const outcome = isAborted
                        ? "aborted"
                        : isTerminalProviderStreamError(state)
                          ? "error"
                          : "success";
                      captureAgentCompletionAnalytics({
                        posthog,
                        userId,
                        chatId,
                        endpoint: "/api/agent-long",
                        mode,
                        subscription,
                        sandboxInfo,
                        outcome,
                        chatLogger,
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
                        if (
                          isAborted &&
                          !triggerSignal.aborted &&
                          newFileIds.length === 0 &&
                          !hasIncompleteToolCalls &&
                          !resolvedUsage
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
                            updateOnly:
                              isAborted && !state.stoppedDueToElapsedTimeout
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

                      if (contextUsageOn) {
                        writeContextUsage(writer, {
                          usedTokens:
                            state.ctxUsage.usedTokens +
                            usageTracker.streamOutputTokens,
                          maxTokens: state.ctxUsage.maxTokens,
                        });
                      }

                      // Don't auto-continue on elapsed timeout — a 58-min run is large enough
                      // that the user should explicitly decide whether to continue rather than
                      // silently chaining up to 5 more hour-long runs.
                      if (
                        (state.stoppedDueToTokenExhaustion ||
                          state.streamFinishReason === "tool-calls") &&
                        !temporary
                      ) {
                        writeAutoContinue(writer);
                      }

                      await deductAccumulatedUsage();
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
      await waitUntilComplete();

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
      await recordAgentLongFailureForDashboard(error, {
        chatId,
        userId,
        runId: ctx.run.id,
        phase: streamPiped ? "streaming" : "setup",
      }).catch((metadataError) => {
        metadata.set("status", "failed");
        console.error(
          "[agent-long] failed to record run error metadata:",
          metadataError,
        );
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

      if (chatMissingAfterStream) {
        await phLogger.flush().catch(() => {});
        return { chatId, assistantMessageId };
      }

      // Pre-stream setup failed (DB fetch, message processing, etc.). Emit a
      // one-shot UI stream whose onError converts the caught error into the
      // same friendly error chunk format useChat expects. Without this, the
      // frontend transport only sees the run go to FAILED and emits a silent
      // abort, leaving the user stuck on a Stop button with no message.
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
        } catch (pipeErr) {
          console.error(
            "[agent-long] Failed to emit synthetic error stream:",
            pipeErr,
          );
        }
      }

      await phLogger.flush().catch(() => {});
      throw error;
    } finally {
      runCleanupMap.delete(ctx.run.id);
      if (!payload.temporary) {
        try {
          await setActiveTriggerRun({
            chatId,
            triggerRunId: null,
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
