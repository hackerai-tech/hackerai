/**
 * Chat Handler Wide Event Logger
 *
 * Encapsulates wide event logging for chat/agent API requests.
 * Keeps the chat handler clean by providing a simple interface.
 */

import {
  createWideEventBuilder,
  logger,
  type ChatWideEvent,
  type ProviderRequestDiagnostics,
  type WideEventBuilder,
} from "@/lib/logger";
import type {
  CaidoReadyInfo,
  ChatMode,
  ExtraUsageConfig,
  SandboxInfo,
  SandboxBootInfo,
} from "@/types";
import { isSubscriptionTier } from "@/types";
import type { ChatSDKError } from "@/lib/errors";
import type { PostHog } from "posthog-node";
import { after } from "next/server";
import { phLogger } from "@/lib/posthog/server";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";
import type { UsageCostRecord } from "@/lib/usage-tracker";
import type { OpenRouterModelMetadata } from "@/lib/api/openrouter-metadata";
import {
  extractErrorDetails,
  extractRetryAttempts,
  getProviderErrorCategory,
  getProviderStatusCode,
  type ProviderErrorCategory,
} from "@/lib/utils/error-utils";
import {
  getLimitPressureContext,
  getLimitTypeForCapReason,
  isPaidMonthlyCapHitReason,
  type LimitCapReason,
} from "@/lib/limit-pressure";
import {
  getFreeAskReasoningExperimentProperties,
  type FreeAskReasoningExperimentAssignment,
} from "@/lib/experiments/free-ask-reasoning";

export interface ChatLoggerConfig {
  chatId: string;
  endpoint: "/api/chat" | "/api/agent-long";
}

export interface RequestDetails {
  mode: ChatMode;
  isTemporary: boolean;
  isRegenerate: boolean;
}

export interface UserContext {
  id: string;
  subscription: string;
  region?: string;
}

export interface ChatContext {
  messageCount: number;
  estimatedInputTokens: number;
  isNewChat: boolean;
  fileCount?: number;
  imageCount?: number;
  notesEnabled: boolean;
}

export interface RateLimitContext {
  pointsDeducted?: number;
  extraUsagePointsDeducted?: number;
  monthly?: { remaining: number; limit: number };
  remaining?: number;
  subscription: string;
}

export interface StreamResult {
  finishReason?: string;
  wasAborted: boolean;
  wasPreemptiveTimeout: boolean;
  hadSummarization: boolean;
}

function posthogProviderException(
  error: unknown,
  details: Record<string, unknown>,
): Error {
  const message = getProviderDiagnosticMessage(details);
  if (!(error instanceof Error)) {
    const enriched = new Error(message);
    const errorName = details.errorName;
    if (
      typeof errorName === "string" &&
      errorName.length > 0 &&
      errorName !== "UnknownError"
    ) {
      enriched.name = errorName;
    }
    return enriched;
  }
  if (message === "Provider streaming error" || message === error.message) {
    return error;
  }

  const enriched = new Error(message);
  enriched.name = error.name;
  (enriched as Error & { cause?: unknown }).cause = error;
  return enriched;
}

const truncateLogString = (value: string, maxLength = 500): string =>
  value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;

const COMPACT_CHAT_ERROR_METADATA_KEYS = [
  "db_operation",
  "db_error_name",
  "db_error_message",
  "db_error_code",
  "db_cause_error_code",
  "db_failure_stage",
  "finish_reason",
  "message_role",
  "mode",
  "parts_size_kb",
  "part_count",
  "largest_part_type",
  "largest_part_size_kb",
  "tool_part_count",
  "data_part_count",
  "reasoning_chars",
  "was_aborted",
  "was_preemptive_timeout",
  "empty_prompt",
  "truncation_dropped_all_messages",
  "empty_after_processing",
  "existing_messages_count",
  "new_messages_count",
  "all_messages_count",
  "total_tokens_before",
  "max_tokens",
  "file_ids_count",
  "largest_file_token",
  "processing_input_message_count",
  "processing_input_user_message_count",
  "processing_input_assistant_message_count",
  "processing_input_system_message_count",
  "processing_input_other_role_message_count",
  "processing_input_empty_parts_message_count",
  "processing_input_part_count",
  "processing_input_text_part_count",
  "processing_input_nonempty_text_part_count",
  "processing_input_file_part_count",
  "processing_input_file_with_url_count",
  "processing_input_file_with_file_id_count",
  "processing_input_local_desktop_file_part_count",
  "processing_input_local_desktop_file_with_local_path_count",
  "processing_input_local_desktop_file_missing_local_path_count",
  "processing_input_ui_only_part_count",
  "processing_input_step_start_part_count",
  "processing_input_reasoning_part_count",
  "processing_input_nonempty_reasoning_part_count",
  "processing_input_tool_part_count",
  "processing_input_data_part_count",
  "processing_input_other_part_count",
  "processing_input_regenerate",
  "processing_input_auto_continue",
  "processing_input_temporary",
  "processing_input_sandbox_preference",
  "capReason",
  "limitType",
  "costGuardrail",
  "paidMonthlyExhaustion",
  "upgradeAvailable",
  "addCreditAvailable",
  "primaryCta",
  "eligibleCtas",
  "resetTimestamp",
  "providerErrorCategory",
  "providerStatusCode",
  "providerErrorRetriable",
  "paidDailyFreeAllowance",
  "upload_failure_kind",
  "upload_failure_cause",
  "upload_failure_transient_sandbox_command",
  "upload_failure_protocol",
  "upload_failure_url_length",
  "upload_retried_with_fresh_sandbox",
  "localSandboxFallbackBlocked",
  "sandboxFallbackReason",
  "requestedPreference",
  "actualSandbox",
] as const;

const compactChatErrorMetadata = (
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!metadata) return undefined;

  const compact: Record<string, unknown> = {};
  for (const key of COMPACT_CHAT_ERROR_METADATA_KEYS) {
    const value = metadata[key];
    if (value !== undefined) compact[key] = value;
  }

  return Object.keys(compact).length > 0 ? compact : undefined;
};

const providerErrorEventName = (category: ProviderErrorCategory): string =>
  category === "content_blocked"
    ? "provider_content_blocked"
    : category === "stream_terminated"
      ? "provider_stream_terminated"
      : "provider_streaming_error";

const providerErrorMessage = (category: ProviderErrorCategory): string =>
  category === "content_blocked"
    ? "Provider content blocked"
    : category === "stream_terminated"
      ? "Provider stream terminated"
      : category === "timeout"
        ? "Provider stream timeout"
        : "Provider streaming error";

const SYNTHETIC_SSE_JSON_ERROR_MESSAGE = "JSON error injected into SSE stream";

const providerCategoryDiagnosticMessage = (
  category: ProviderErrorCategory,
  statusCode?: number,
): string => {
  const suffix = statusCode ? ` (${statusCode})` : "";
  switch (category) {
    case "rate_limited":
      return `Provider rate limited${suffix}`;
    case "content_blocked":
      return `Provider content blocked${suffix}`;
    case "provider_5xx":
      return `Provider server error${suffix}`;
    case "provider_4xx":
      return `Provider request rejected${suffix}`;
    case "stream_terminated":
      return "Provider stream terminated";
    case "timeout":
      return "Provider stream timeout";
    case "unknown":
      return "Provider streaming error";
  }
};

const providerWideErrorType = (
  category: ProviderErrorCategory | undefined,
): string => {
  if (category === "content_blocked") return "ProviderContentBlocked";
  if (category === "stream_terminated") return "ProviderStreamTerminated";
  if (category === "timeout") return "ProviderTimeout";
  if (category) return "ProviderError";
  return "UnexpectedError";
};

const getProviderDiagnosticMessage = (
  details: Record<string, unknown>,
): string => {
  for (const key of ["providerRawError", "providerErrorMessage"] as const) {
    const value = details[key];
    if (typeof value === "string" && value.length > 0 && value !== "undefined")
      return value;
  }

  const errorMessage = details.errorMessage;
  if (
    typeof errorMessage === "string" &&
    errorMessage.length > 0 &&
    errorMessage !== "undefined"
  ) {
    if (errorMessage !== SYNTHETIC_SSE_JSON_ERROR_MESSAGE) {
      return errorMessage;
    }

    const category = getProviderErrorCategory(details);
    if (category !== "unknown") {
      return providerCategoryDiagnosticMessage(
        category,
        getProviderStatusCode(details),
      );
    }
  }

  return "Provider streaming error";
};

const isRetriableProviderCategory = (
  category: ProviderErrorCategory,
): boolean =>
  category === "rate_limited" ||
  category === "provider_5xx" ||
  category === "stream_terminated" ||
  category === "timeout";

const shouldCaptureProviderException = (
  category: ProviderErrorCategory,
): boolean => category !== "stream_terminated" && category !== "timeout";

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const getModelProviderSlug = (modelSlug: string | undefined) =>
  modelSlug?.includes("/") ? modelSlug.split("/", 1)[0] : undefined;

/**
 * Creates a chat logger instance for tracking wide events
 */
export function createChatLogger(config: ChatLoggerConfig) {
  const builder = createWideEventBuilder(config.chatId, config.endpoint);

  // Cache identity/context fields so emitChatError can fire discrete PostHog
  // events (e.g. monthly_cap_hit) without forcing the call site to thread
  // them through. Populated by the corresponding setX methods below.
  let userId: string | undefined;
  let subscription: string | undefined;
  let mode: ChatMode | undefined;
  let monthlyRemainingPercent: number | undefined;
  let lastProviderErrorCategory: ProviderErrorCategory | undefined;
  let lastProviderErrorStatusCode: number | undefined;

  return {
    /**
     * Set initial request details
     */
    setRequestDetails(details: RequestDetails) {
      mode = details.mode;
      builder.setRequestDetails(details);
    },

    /**
     * Set user context
     */
    setUser(user: UserContext) {
      userId = user.id;
      subscription = user.subscription;
      builder.setUser(user);
    },

    /**
     * Set chat context and model
     */
    setChat(chat: ChatContext, model: string) {
      builder.setChat(chat);
      builder.setModel(model);
    },

    /**
     * Set rate limit and extra usage context
     */
    setRateLimit(
      context: RateLimitContext,
      extraUsageConfig?: ExtraUsageConfig,
    ) {
      monthlyRemainingPercent = context.monthly
        ? Math.round((context.monthly.remaining / context.monthly.limit) * 100)
        : undefined;
      builder.setExtraUsage(extraUsageConfig);
      builder.setRateLimit({
        pointsDeducted: context.pointsDeducted,
        extraUsagePointsDeducted: context.extraUsagePointsDeducted,
        monthlyRemainingPercent,
        freeRemaining:
          context.subscription === "free" ? context.remaining : undefined,
      });
    },

    /**
     * Start stream timing
     */
    startStream() {
      builder.startStream();
    },

    /**
     * Set sandbox execution info
     */
    setSandbox(info: ChatWideEvent["sandbox"] | null) {
      if (info) {
        builder.setSandbox(info);
      }
    },

    /**
     * Record sandbox boot timing (first call wins within a request).
     */
    setSandboxBoot(info: SandboxBootInfo) {
      builder.setSandboxBoot(info);
    },

    /**
     * Record Caido proxy setup timing (first call wins within a request).
     */
    setCaidoReady(info: CaidoReadyInfo) {
      builder.setCaidoReady(info);
    },

    /**
     * Record a tool call
     */
    recordToolCall(name: string, sandboxType?: string) {
      builder.recordToolCall(name, sandboxType);
    },

    /**
     * Set model and usage from stream response
     */
    setStreamResponse(
      responseModel: string | undefined,
      usage: Record<string, unknown> | undefined,
      openRouterMetadata?: OpenRouterModelMetadata,
    ) {
      if (responseModel) {
        builder.setActualModel(responseModel);
      }
      if (openRouterMetadata) {
        builder.setOpenRouterMetadata(openRouterMetadata);
      }
      builder.setUsage(usage);
    },

    /**
     * Record Anthropic prompt repair before provider call.
     */
    recordAnthropicPromptRepair(repair: {
      action: "appended_continue" | "trimmed";
      reason:
        | "useful_assistant_tail"
        | "no_useful_content"
        | "dangling_tool_call";
      trailingAssistantContentTypes?: string[];
      model: string;
    }) {
      builder.recordAnthropicPromptRepair(repair);
      phLogger.event("anthropic_prompt_repaired", {
        userId,
        chat_id: config.chatId,
        endpoint: config.endpoint,
        mode,
        subscription,
        model: repair.model,
        action: repair.action,
        reason: repair.reason,
        trailing_assistant_content_types: repair.trailingAssistantContentTypes,
      });
    },

    /**
     * Record that OpenRouter served a configured fallback model.
     */
    recordModelFallback(fallback: {
      requested: string | undefined;
      served: string;
      chain: string[];
      model: string;
    }) {
      builder.recordModelFallback({
        served: fallback.served,
        chain: fallback.chain,
      });
      phLogger.event("model_fallback_served", {
        userId,
        chat_id: config.chatId,
        endpoint: config.endpoint,
        mode,
        subscription,
        configured_model: fallback.model,
        requested_model: fallback.requested,
        served_model: fallback.served,
        fallback_chain: fallback.chain,
      });
    },

    /**
     * Record sanitized provider request shape for later error diagnosis.
     */
    recordProviderRequestDiagnostics(diagnostics: ProviderRequestDiagnostics) {
      builder.setProviderRequestDiagnostics(diagnostics);
    },

    /**
     * Set cache metrics for the wide event
     */
    setCacheMetrics(metrics: {
      cacheHitRate: number | null;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }) {
      builder.setCacheMetrics(metrics);
    },

    /**
     * Record a provider streaming error. Fans out to:
     *   - Vercel runtime logs (structured JSON via logger.warn/logger.error)
     *   - PostHog telemetry (warnings for transport closes, exceptions for errors)
     *   - The wide event (had_provider_error + provider_error fields)
     *
     * Does NOT change outcome — emitSuccess/emitChatError still decides that.
     */
    recordProviderError(
      error: unknown,
      context: {
        mode?: string;
        model?: string;
        requestedModelSlug?: string;
        fallbackModelSlugs?: string[];
        userId?: string;
        subscription?: string;
        isTemporary?: boolean;
        providerRequest?: ProviderRequestDiagnostics;
      },
    ) {
      const { providerRequest, ...providerContext } = context;
      const details = extractErrorDetails(error);
      const attempts = extractRetryAttempts(error);
      const category = getProviderErrorCategory(details);
      const providerStatusCode = getProviderStatusCode(details);
      const diagnosticMessage = getProviderDiagnosticMessage(details);
      const providerName = nonEmptyString(details.providerName);
      const configuredModel =
        nonEmptyString(providerContext.model) ??
        nonEmptyString(providerRequest?.model);
      const requestedModelSlug =
        nonEmptyString(providerContext.requestedModelSlug) ??
        nonEmptyString(providerRequest?.requested_model_slug);
      const modelProviderSlug = getModelProviderSlug(requestedModelSlug);
      const openrouterGenerationId = nonEmptyString(
        details.openrouterGenerationId,
      );
      const normalizedProviderContext = {
        ...(providerName && {
          provider_name: providerName,
          provider_name_source: "openrouter_error_metadata",
        }),
        ...(configuredModel && { configured_model: configuredModel }),
        ...(requestedModelSlug && { requested_model_slug: requestedModelSlug }),
        ...(modelProviderSlug && { model_provider_slug: modelProviderSlug }),
        ...(openrouterGenerationId && {
          openrouter_generation_id: openrouterGenerationId,
        }),
      };
      lastProviderErrorCategory = category;
      lastProviderErrorStatusCode = providerStatusCode;

      const logContext = {
        event: providerErrorEventName(category),
        chat_id: config.chatId,
        endpoint: config.endpoint,
        provider_error_category: category,
        provider_diagnostic_message: diagnosticMessage,
        ...(providerStatusCode && { provider_status_code: providerStatusCode }),
        ...providerContext,
        ...details,
        ...normalizedProviderContext,
        ...(attempts && { provider_attempts: attempts }),
        ...(providerRequest && { provider_request: providerRequest }),
      };

      if (!shouldCaptureProviderException(category)) {
        logger.warn(providerErrorMessage(category), logContext);
      } else {
        logger.error(
          providerErrorMessage(category),
          error instanceof Error ? error : undefined,
          logContext,
        );
      }

      const phContext = {
        event: providerErrorEventName(category),
        chatId: config.chatId,
        endpoint: config.endpoint,
        providerErrorCategory: category,
        providerDiagnosticMessage: diagnosticMessage,
        ...(providerStatusCode && { providerStatusCode }),
        ...providerContext,
        ...details,
        ...normalizedProviderContext,
        ...(attempts && { provider_attempts: attempts }),
        ...(providerRequest && { provider_request: providerRequest }),
      };

      if (!shouldCaptureProviderException(category)) {
        phLogger.warn(providerErrorMessage(category), phContext);
      } else {
        phLogger.error(providerErrorMessage(category), {
          error: posthogProviderException(error, details),
          ...phContext,
        });
      }

      builder.markProviderError({
        category,
        statusCode: providerStatusCode,
        url: details.providerUrl as string | undefined,
        reason: (error as { reason?: string })?.reason,
        message: diagnosticMessage,
        retriable:
          typeof details.isRetryable === "boolean"
            ? details.isRetryable
            : isRetriableProviderCategory(category),
        providerName,
        providerNameSource: providerName
          ? "openrouter_error_metadata"
          : undefined,
        configuredModel,
        requestedModelSlug,
        modelProviderSlug,
        openrouterGenerationId,
        attempts,
      });
    },

    /**
     * Finalize and emit success event
     */
    emitSuccess(result: StreamResult) {
      builder.setStreamResult(result);
      if (result.wasAborted) {
        builder.setAborted();
      } else {
        builder.setSuccess();
      }
      logger.info(builder.build());
    },

    /**
     * Finalize and emit error event for ChatSDKError
     */
    emitChatError(error: ChatSDKError) {
      const cause =
        typeof error.cause === "string"
          ? truncateLogString(error.cause)
          : undefined;

      builder.setError({
        type: "ChatSDKError",
        code: `${error.type}:${error.surface}`,
        message: error.message,
        cause,
        statusCode: error.statusCode,
        retriable: error.type === "rate_limit",
        metadata: compactChatErrorMetadata(error.metadata),
      });
      logger.info(builder.build());

      if (error.type === "rate_limit" && subscription) {
        const capReason =
          (error.metadata?.capReason as LimitCapReason | undefined) ??
          "unknown";
        const resetTimestamp = error.metadata?.resetTimestamp as
          | number
          | undefined;
        const subscriptionTier = isSubscriptionTier(subscription)
          ? subscription
          : undefined;
        const pressure = subscriptionTier
          ? getLimitPressureContext({
              subscription: subscriptionTier,
              capReason,
            })
          : {
              limitType: getLimitTypeForCapReason(capReason),
              costGuardrail: false,
              paidMonthlyExhaustion: false,
              upgradeAvailable: false,
              addCreditAvailable: false,
              primaryCta: undefined,
              eligibleCtas: [],
            };
        const paidDailyFreeAllowance =
          error.metadata?.paidDailyFreeAllowance &&
          typeof error.metadata.paidDailyFreeAllowance === "object"
            ? (error.metadata.paidDailyFreeAllowance as Record<string, unknown>)
            : undefined;

        phLogger.event(
          PAID_FUNNEL_EVENTS.limitHit,
          paidFunnelProperties({
            userId,
            subscription_tier: subscription,
            mode,
            limit_type: pressure.limitType,
            cap_reason: capReason,
            monthly_remaining_percent: monthlyRemainingPercent,
            reset_timestamp: resetTimestamp,
            cost_guardrail: pressure.costGuardrail,
            paid_monthly_exhaustion: pressure.paidMonthlyExhaustion,
            upgrade_available: pressure.upgradeAvailable,
            add_credit_available: pressure.addCreditAvailable,
            primary_cta: pressure.primaryCta,
            eligible_ctas: pressure.eligibleCtas,
            paid_daily_free_allowance_available:
              paidDailyFreeAllowance?.available,
            paid_daily_free_allowance_unavailable_reason:
              paidDailyFreeAllowance?.unavailableReason,
            paid_daily_free_allowance_requests_remaining:
              paidDailyFreeAllowance?.requestsRemaining,
            paid_daily_free_allowance_request_limit:
              paidDailyFreeAllowance?.requestLimit,
            paid_daily_free_allowance_cost_remaining_dollars:
              paidDailyFreeAllowance?.costRemainingDollars,
            paid_daily_free_allowance_cost_limit_dollars:
              paidDailyFreeAllowance?.costLimitDollars,
            paid_daily_free_allowance_rollout_percent:
              paidDailyFreeAllowance?.rolloutPercent,
            chat_id: config.chatId,
            endpoint: config.endpoint,
            $set: {
              subscription_tier: subscription,
              last_limit_hit_at: new Date().toISOString(),
            },
          }),
        );
      }

      // Fire a discrete PostHog event when a paid user is blocked at the
      // monthly cap. Used to size the cap-hit cohort and correlate against
      // subscription_changed / subscription_cancelled events.
      if (
        error.type === "rate_limit" &&
        subscription &&
        isSubscriptionTier(subscription) &&
        subscription !== "free"
      ) {
        const capReason =
          (error.metadata?.capReason as LimitCapReason | undefined) ??
          "unknown";
        if (!isPaidMonthlyCapHitReason(capReason)) return;
        const pressure = getLimitPressureContext({
          subscription,
          capReason,
        });
        phLogger.event("monthly_cap_hit", {
          userId,
          subscription,
          mode,
          cap_reason: capReason,
          monthly_remaining_percent: monthlyRemainingPercent,
          cost_guardrail: pressure.costGuardrail,
          primary_cta: pressure.primaryCta,
          eligible_ctas: pressure.eligibleCtas,
          chat_id: config.chatId,
          endpoint: config.endpoint,
          $set: {
            subscription_tier: subscription,
            last_cap_hit_at: new Date().toISOString(),
          },
        });
      }
    },

    /**
     * Finalize and emit error event for unexpected or previously recorded
     * provider errors.
     */
    emitUnexpectedError(error: unknown) {
      const details = extractErrorDetails(error);
      const inferredProviderCategory = getProviderErrorCategory(details);
      const providerCategory =
        lastProviderErrorCategory ??
        (inferredProviderCategory !== "unknown"
          ? inferredProviderCategory
          : undefined);
      const diagnosticMessage = getProviderDiagnosticMessage(details);
      const message =
        diagnosticMessage !== "Provider streaming error"
          ? diagnosticMessage
          : "Unknown error occurred";

      if (!providerCategory) {
        logger.error(
          "Unexpected error in chat route",
          error instanceof Error ? error : undefined,
          { event: "chat_route_unexpected_error", chatId: config.chatId },
        );
      }

      builder.setError({
        type: providerWideErrorType(providerCategory),
        message,
        statusCode: lastProviderErrorStatusCode ?? 503,
        retriable: providerCategory
          ? isRetriableProviderCategory(providerCategory)
          : false,
      });
      logger.info(builder.build());
    },

    /**
     * Get recorded tool calls
     */
    getToolCalls() {
      return builder.getToolCalls();
    },

    /**
     * Get the underlying builder (for advanced use cases)
     */
    getBuilder(): WideEventBuilder {
      return builder;
    },
  };
}

export type ChatLogger = ReturnType<typeof createChatLogger>;

/**
 * Capture aggregated tool usage to PostHog at end of request.
 * One event is emitted per tool to keep analytics useful while
 * avoiding the cost of one PostHog event per individual tool call.
 */
export function captureToolCalls({
  posthog,
  chatLogger,
  userId,
  mode,
}: {
  posthog: PostHog | null;
  chatLogger: ChatLogger | undefined;
  userId: string;
  mode: ChatMode;
}) {
  if (!posthog || !chatLogger) return;
  const toolCalls = chatLogger.getToolCalls();
  if (toolCalls.length === 0) return;

  const aggregatedToolCalls = new Map<
    string,
    { name: string; count: number }
  >();

  for (const tool of toolCalls) {
    const existing = aggregatedToolCalls.get(tool.name);
    if (existing) {
      existing.count += 1;
      continue;
    }
    aggregatedToolCalls.set(tool.name, { name: tool.name, count: 1 });
  }

  for (const tool of aggregatedToolCalls.values()) {
    posthog.capture({
      distinctId: userId,
      event: "hackerai-tool_usage",
      properties: {
        mode,
        toolName: tool.name,
        count: tool.count,
        toolCallCount: tool.count,
      },
    });
  }
}

export type AgentRunOutcome = "success" | "aborted" | "error";

type AgentCompletionAnalyticsArgs = {
  posthog: PostHog | null;
  userId: string;
  chatId: string;
  endpoint: "/api/chat" | "/api/agent-long";
  mode: ChatMode;
  subscription: string;
  sandboxInfo: SandboxInfo | null;
  outcome: AgentRunOutcome;
  chatLogger: ChatLogger | undefined;
};

export function captureAgentRun({
  posthog,
  userId,
  mode,
  subscription,
  sandboxInfo,
  outcome,
}: {
  posthog: PostHog | null;
  userId: string;
  mode: ChatMode;
  subscription: string;
  sandboxInfo: SandboxInfo | null;
  outcome: AgentRunOutcome;
}) {
  if (!posthog || mode !== "agent") return;
  posthog.capture({
    distinctId: userId,
    event: "hackerai-agent_run",
    properties: {
      mode,
      subscription,
      subscription_tier: subscription,
      outcome,
      ...(sandboxInfo?.type && {
        sandboxType: sandboxInfo.type,
        sandbox_type: sandboxInfo.type,
      }),
    },
  });
}

export function captureFreeAgentValueReached({
  posthog,
  userId,
  chatId,
  endpoint,
  mode,
  subscription,
  sandboxInfo,
  outcome,
  chatLogger,
}: {
  posthog: PostHog | null;
  userId: string;
  chatId: string;
  endpoint: "/api/chat" | "/api/agent-long";
  mode: ChatMode;
  subscription: string;
  sandboxInfo: SandboxInfo | null;
  outcome: AgentRunOutcome;
  chatLogger: ChatLogger | undefined;
}) {
  if (!posthog || mode !== "agent" || subscription !== "free") return;
  if (outcome !== "success") return;

  const now = new Date().toISOString();
  const toolCallCount = chatLogger?.getToolCalls().length ?? 0;

  posthog.capture({
    distinctId: userId,
    event: "hackerai-free_agent_value_reached",
    properties: {
      user_id: userId,
      chat_id: chatId,
      endpoint,
      mode,
      subscription,
      subscription_tier: subscription,
      outcome,
      tool_call_count: toolCallCount,
      agent_value_event_version: 1,
      ...(sandboxInfo?.type && { sandbox_type: sandboxInfo.type }),
      $set_once: {
        first_free_agent_value_reached_at: now,
      },
      $set: {
        subscription_tier: subscription,
        last_free_agent_value_reached_at: now,
      },
    },
  });
}

export function captureAgentCompletionAnalytics(
  args: AgentCompletionAnalyticsArgs,
) {
  const { posthog, userId, mode, subscription, sandboxInfo, outcome } = args;
  captureAgentRun({
    posthog,
    userId,
    mode,
    subscription,
    sandboxInfo,
    outcome,
  });
  captureFreeAgentValueReached(args);
}

/**
 * Capture one cost event per request with usage. In PostHog, answer
 * "how much does each user cost you?" by summing cost_dollars on
 * hackerai-usage_cost grouped by distinct_id (or user_id).
 */
export function captureUsageCost({
  posthog,
  userId,
  subscription,
  organizationId,
  chatId,
  endpoint,
  mode,
  usage,
  paidDailyFreeAllowance,
  freeAskReasoningExperiment,
}: {
  posthog: PostHog | null;
  userId: string;
  subscription: string;
  organizationId?: string;
  chatId: string;
  endpoint: "/api/chat" | "/api/agent-long";
  mode: ChatMode;
  usage: UsageCostRecord;
  paidDailyFreeAllowance?: {
    active: boolean;
    cutOff?: boolean;
    requestLimit?: number;
    costLimitDollars?: number;
    resetTimestamp?: number;
  };
  freeAskReasoningExperiment?: FreeAskReasoningExperimentAssignment | null;
}) {
  if (!posthog) return;
  posthog.capture({
    distinctId: userId,
    event: "hackerai-usage_cost",
    properties: {
      user_id: userId,
      subscription,
      subscription_tier: subscription,
      ...(organizationId && { organization_id: organizationId }),
      chat_id: chatId,
      endpoint,
      mode,
      model: usage.model,
      usage_type: usage.type,
      cost_dollars: usage.costDollars,
      included_cost_dollars: usage.includedCostDollars,
      extra_usage_cost_dollars: usage.extraUsageCostDollars,
      included_points_deducted: usage.includedPointsDeducted,
      extra_usage_points_deducted: usage.extraUsagePointsDeducted,
      model_cost_dollars: usage.modelCostDollars,
      non_model_cost_dollars: usage.nonModelCostDollars,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
      cache_read_tokens: usage.cacheReadTokens ?? 0,
      cache_write_tokens: usage.cacheWriteTokens ?? 0,
      cost_source: usage.costSource,
      ...(freeAskReasoningExperiment && {
        ...getFreeAskReasoningExperimentProperties(freeAskReasoningExperiment),
      }),
      ...(paidDailyFreeAllowance?.active && {
        limit_rescue_type: "paid_daily_free_allowance",
        paid_daily_free_allowance_active: true,
        paid_daily_free_allowance_cut_off:
          paidDailyFreeAllowance.cutOff === true,
        paid_daily_free_allowance_request_limit:
          paidDailyFreeAllowance.requestLimit,
        paid_daily_free_allowance_cost_limit_dollars:
          paidDailyFreeAllowance.costLimitDollars,
        paid_daily_free_allowance_reset_timestamp:
          paidDailyFreeAllowance.resetTimestamp,
      }),
      $set: {
        subscription_tier: subscription,
        last_usage_cost_at: new Date().toISOString(),
      },
    },
  });
}

export function shutdownPostHog(posthog: PostHog | null) {
  if (!posthog) return;
  after(() => posthog.shutdown());
}
