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

export interface ChatLoggerConfig {
  chatId: string;
  endpoint: "/api/chat" | "/api/agent" | "/api/agent-long";
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
  hasSandboxFiles: boolean;
  hasFileAttachments: boolean;
  fileCount?: number;
  fileImageCount?: number;
  sandboxPreference?: string;
  memoryEnabled: boolean;
  isNewChat: boolean;
}

export interface RateLimitContext {
  pointsDeducted?: number;
  extraUsagePointsDeducted?: number;
  session?: { remaining: number; limit: number };
  weekly?: { remaining: number; limit: number };
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
        sessionRemainingPercent: context.session
          ? Math.round(
              (context.session.remaining / context.session.limit) * 100,
            )
          : undefined,
        weeklyRemainingPercent: context.weekly
          ? Math.round((context.weekly.remaining / context.weekly.limit) * 100)
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
     * Get the underlying builder (for advanced use cases)
     */
    getBuilder(): WideEventBuilder {
      return builder;
    },
  };
}

export type ChatLogger = ReturnType<typeof createChatLogger>;
