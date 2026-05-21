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
  type WideEventBuilder,
} from "@/lib/logger";
import type {
  CaidoReadyInfo,
  ChatMode,
  ExtraUsageConfig,
  SandboxInfo,
  SandboxBootInfo,
} from "@/types";
import type { ChatSDKError } from "@/lib/errors";
import type { PostHog } from "posthog-node";
import { after } from "next/server";
import { phLogger } from "@/lib/posthog/server";
import {
  extractErrorDetails,
  extractRetryAttempts,
} from "@/lib/utils/error-utils";

export interface ChatLoggerConfig {
  chatId: string;
  endpoint: "/api/chat" | "/api/agent";
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
  memoryEnabled: boolean;
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

function providerErrorCategory(details: Record<string, unknown>): string {
  const statusCode =
    typeof details.statusCode === "number" ? details.statusCode : undefined;
  if (statusCode === 429) return "rate_limited";
  if (statusCode != null && statusCode >= 500) return "provider_5xx";
  if (statusCode != null && statusCode >= 400) return "provider_4xx";

  const message =
    typeof details.errorMessage === "string" ? details.errorMessage : "";
  if (/terminated|aborted|abort/i.test(message)) return "stream_terminated";
  if (/timeout|timed out/i.test(message)) return "timeout";
  return "unknown";
}

function posthogProviderException(
  error: unknown,
  details: Record<string, unknown>,
): Error {
  if (error instanceof Error) return error;
  const message =
    typeof details.errorMessage === "string" && details.errorMessage.length > 0
      ? details.errorMessage
      : "Provider streaming error";
  return new Error(message);
}

const truncateLogString = (value: string, maxLength = 500): string =>
  value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;

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
    ) {
      if (responseModel) {
        builder.setActualModel(responseModel);
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
     *   - Vercel runtime logs (structured JSON via logger.error)
     *   - PostHog exception capture (phLogger.error)
     *   - The wide event (had_provider_error + provider_error fields)
     *
     * Does NOT change outcome — emitSuccess/emitChatError still decides that.
     */
    recordProviderError(
      error: unknown,
      context: {
        mode?: string;
        model?: string;
        userId?: string;
        subscription?: string;
        isTemporary?: boolean;
      },
    ) {
      const details = extractErrorDetails(error);
      const attempts = extractRetryAttempts(error);
      const category = providerErrorCategory(details);

      logger.error(
        "Provider streaming error",
        error instanceof Error ? error : undefined,
        {
          chat_id: config.chatId,
          endpoint: config.endpoint,
          provider_error_category: category,
          ...context,
          ...details,
          ...(attempts && { provider_attempts: attempts }),
        },
      );

      phLogger.error("Provider streaming error", {
        error: posthogProviderException(error, details),
        chatId: config.chatId,
        endpoint: config.endpoint,
        providerErrorCategory: category,
        ...context,
        ...details,
        ...(attempts && { provider_attempts: attempts }),
      });

      builder.markProviderError({
        statusCode: details.statusCode as number | undefined,
        url: details.providerUrl as string | undefined,
        reason: (error as { reason?: string })?.reason,
        message: details.errorMessage as string | undefined,
        retriable: details.isRetryable as boolean | undefined,
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
        metadata: error.metadata,
      });
      logger.info(builder.build());

      // Fire a discrete PostHog event when a paid user is blocked at the
      // monthly cap. Used to size the cap-hit cohort and correlate against
      // subscription_changed / subscription_cancelled events.
      if (
        error.type === "rate_limit" &&
        subscription &&
        subscription !== "free"
      ) {
        const capReason =
          (error.metadata?.capReason as string | undefined) ?? "unknown";
        phLogger.event("monthly_cap_hit", {
          userId,
          subscription,
          mode,
          cap_reason: capReason,
          monthly_remaining_percent: monthlyRemainingPercent,
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
     * Finalize and emit error event for unexpected errors
     */
    emitUnexpectedError(error: unknown) {
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";

      logger.error(
        "Unexpected error in chat route",
        error instanceof Error ? error : undefined,
        { chatId: config.chatId },
      );

      builder.setError({
        type: "UnexpectedError",
        message,
        statusCode: 503,
        retriable: false,
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
  outcome: "success" | "aborted" | "error";
}) {
  if (!posthog || mode !== "agent") return;
  posthog.capture({
    distinctId: userId,
    event: "hackerai-agent_run",
    properties: {
      mode,
      subscription,
      outcome,
      ...(sandboxInfo?.type && { sandboxType: sandboxInfo.type }),
    },
  });
}

export function shutdownPostHog(posthog: PostHog | null) {
  if (!posthog) return;
  after(() => posthog.shutdown());
}
