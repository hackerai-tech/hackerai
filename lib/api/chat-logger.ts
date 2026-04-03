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
import type { ChatMode, ExtraUsageConfig } from "@/types";
import type { ChatSDKError } from "@/lib/errors";
import type { PostHog } from "posthog-node";
import { after } from "next/server";

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

/**
 * Creates a chat logger instance for tracking wide events
 */
export function createChatLogger(config: ChatLoggerConfig) {
  const builder = createWideEventBuilder(config.chatId, config.endpoint);

  return {
    /**
     * Set initial request details
     */
    setRequestDetails(details: RequestDetails) {
      builder.setRequestDetails(details);
    },

    /**
     * Set user context
     */
    setUser(user: UserContext) {
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
      builder.setExtraUsage(extraUsageConfig);
      builder.setRateLimit({
        pointsDeducted: context.pointsDeducted,
        extraUsagePointsDeducted: context.extraUsagePointsDeducted,
        monthlyRemainingPercent: context.monthly
          ? Math.round(
              (context.monthly.remaining / context.monthly.limit) * 100,
            )
          : undefined,
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
      builder.setError({
        type: "ChatSDKError",
        code: `${error.type}:${error.surface}`,
        message: error.message,
        statusCode: error.statusCode,
        retriable: error.type === "rate_limit",
      });
      logger.info(builder.build());
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
 * Capture all tool call events to PostHog at end of request.
 * Events are queued synchronously and flushed after the response is sent.
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
  for (const tool of toolCalls) {
    posthog.capture({
      distinctId: userId,
      event: "hackerai-" + tool.name,
      properties: {
        mode,
        ...(tool.sandbox_type && { sandboxType: tool.sandbox_type }),
      },
    });
  }
  after(() => posthog.shutdown());
}
