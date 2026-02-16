/**
 * Wide Event Logger
 *
 * Implements the wide event logging pattern for comprehensive request observability.
 * One event per request with all context, emitted at the end of the request lifecycle.
 *
 * @see docs/logging-best-practices.md
 */

import type { ChatMode, ExtraUsageConfig } from "@/types";

/**
 * Wide event structure for chat/agent API requests
 */
export interface ChatWideEvent {
  // Request identifiers
  timestamp: string;
  request_id: string;
  chat_id: string;
  assistant_id?: string;

  // Service context
  service: "chat-handler" | "agent-task";
  endpoint: "/api/chat" | "/api/agent" | "/api/agent-long";
  version: string;
  region?: string;

  // Request details
  mode: ChatMode;
  is_temporary: boolean;
  is_regenerate: boolean;
  is_new_chat: boolean;

  // User context
  user: {
    id: string;
    subscription: string;
  };

  // Business context
  chat: {
    message_count: number;
    estimated_input_tokens: number;
    has_sandbox_files: boolean;
    has_file_attachments: boolean;
    file_count?: number;
    file_image_count?: number;
    sandbox_preference?: string;
    memory_enabled: boolean;
  };

  // Extra usage context (paid users)
  extra_usage?: {
    enabled?: boolean;
    has_balance?: boolean;
    balance_dollars?: number;
    auto_reload_enabled?: boolean;
  };

  // Rate limit context
  rate_limit?: {
    points_deducted?: number;
    extra_usage_points_deducted?: number;
    session_remaining_percent?: number;
    weekly_remaining_percent?: number;
    free_remaining?: number;
  };

  // Model & generation
  model?: {
    configured: string;
    actual?: string;
  };

  // Stream execution
  stream?: {
    duration_ms: number;
    finish_reason?: string;
    was_aborted: boolean;
    was_preemptive_timeout: boolean;
    had_summarization: boolean;
  };

  // Token usage (from model response)
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    reasoning_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    total_cost?: number;
  };

  // Sandbox execution
  sandbox?: {
    type: "e2b" | "local" | "local-sandbox";
    name?: string;
  };

  // Tool execution
  tool_call_count?: number;

  // Outcome
  outcome: "success" | "error" | "aborted";
  status_code: number;

  // Error details (if any)
  error?: {
    type: string;
    code?: string;
    message: string;
    retriable: boolean;
  };
}

/**
 * Builder for constructing wide events throughout the request lifecycle
 */
export class WideEventBuilder {
  private event: Partial<ChatWideEvent>;
  private toolCalls: Array<{ name: string; sandbox_type?: string }> = [];
  private streamStartTime?: number;

  constructor(
    requestId: string,
    chatId: string,
    endpoint: "/api/chat" | "/api/agent" | "/api/agent-long",
  ) {
    this.event = {
      timestamp: new Date().toISOString(),
      request_id: requestId,
      chat_id: chatId,
      service: "chat-handler",
      endpoint,
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "dev",
      region: process.env.VERCEL_REGION,
    };
  }

  /**
   * Set request details
   */
  setRequestDetails(details: {
    mode: ChatMode;
    isTemporary: boolean;
    isRegenerate: boolean;
  }): this {
    this.event.mode = details.mode;
    this.event.is_temporary = details.isTemporary;
    this.event.is_regenerate = details.isRegenerate;
    return this;
  }

  /**
   * Set assistant message ID
   */
  setAssistantId(assistantId: string): this {
    this.event.assistant_id = assistantId;
    return this;
  }

  /**
   * Set user context
   */
  setUser(user: { id: string; subscription: string }): this {
    this.event.user = user;
    return this;
  }

  /**
   * Set chat context
   */
  setChat(chat: {
    messageCount: number;
    estimatedInputTokens: number;
    hasSandboxFiles: boolean;
    hasFileAttachments: boolean;
    fileCount?: number;
    fileImageCount?: number;
    sandboxPreference?: string;
    memoryEnabled: boolean;
    isNewChat: boolean;
  }): this {
    this.event.chat = {
      message_count: chat.messageCount,
      estimated_input_tokens: chat.estimatedInputTokens,
      has_sandbox_files: chat.hasSandboxFiles,
      has_file_attachments: chat.hasFileAttachments,
      file_count: chat.fileCount,
      file_image_count: chat.fileImageCount,
      sandbox_preference: chat.sandboxPreference,
      memory_enabled: chat.memoryEnabled,
    };
    this.event.is_new_chat = chat.isNewChat;
    return this;
  }

  /**
   * Set extra usage config
   */
  setExtraUsage(config: ExtraUsageConfig | undefined): this {
    if (config) {
      this.event.extra_usage = {
        enabled: config.enabled,
        has_balance: config.hasBalance,
        balance_dollars: config.balanceDollars,
        auto_reload_enabled: config.autoReloadEnabled,
      };
    }
    return this;
  }

  /**
   * Set rate limit info
   */
  setRateLimit(info: {
    pointsDeducted?: number;
    extraUsagePointsDeducted?: number;
    sessionRemainingPercent?: number;
    weeklyRemainingPercent?: number;
    freeRemaining?: number;
  }): this {
    this.event.rate_limit = {
      points_deducted: info.pointsDeducted,
      extra_usage_points_deducted: info.extraUsagePointsDeducted,
      session_remaining_percent: info.sessionRemainingPercent,
      weekly_remaining_percent: info.weeklyRemainingPercent,
      free_remaining: info.freeRemaining,
    };
    return this;
  }

  /**
   * Set model info
   */
  setModel(configured: string): this {
    this.event.model = { configured };
    return this;
  }

  /**
   * Update with actual model used (from response)
   */
  setActualModel(actual: string): this {
    if (this.event.model) {
      this.event.model.actual = actual;
    } else {
      this.event.model = { configured: actual, actual };
    }
    return this;
  }

  /**
   * Mark stream start time
   */
  startStream(): this {
    this.streamStartTime = Date.now();
    return this;
  }

  /**
   * Set sandbox execution info
   */
  setSandbox(info: ChatWideEvent["sandbox"]): this {
    this.event.sandbox = info;
    return this;
  }

  /**
   * Record a tool call
   */
  recordToolCall(name: string, sandboxType?: string): this {
    this.toolCalls.push({ name, sandbox_type: sandboxType });
    return this;
  }

  /**
   * Set stream completion details
   */
  setStreamResult(result: {
    finishReason?: string;
    wasAborted: boolean;
    wasPreemptiveTimeout: boolean;
    hadSummarization: boolean;
  }): this {
    this.event.stream = {
      duration_ms: this.streamStartTime ? Date.now() - this.streamStartTime : 0,
      finish_reason: result.finishReason,
      was_aborted: result.wasAborted,
      was_preemptive_timeout: result.wasPreemptiveTimeout,
      had_summarization: result.hadSummarization,
    };
    return this;
  }

  /**
   * Set token usage from model response
   */
  setUsage(usage: Record<string, unknown> | undefined): this {
    if (usage) {
      // Extract provider cost if available (e.g., from OpenRouter)
      const rawCost = (usage as { raw?: { cost?: number } }).raw?.cost;

      this.event.usage = {
        input_tokens: usage.inputTokens as number | undefined,
        output_tokens: usage.outputTokens as number | undefined,
        total_tokens:
          ((usage.inputTokens as number) || 0) +
          ((usage.outputTokens as number) || 0),
        reasoning_tokens: usage.reasoningTokens as number | undefined,
        cache_read_tokens: usage.cacheReadInputTokens as number | undefined,
        cache_write_tokens: usage.cacheCreationInputTokens as
          | number
          | undefined,
        // Store provider cost for build() to use
        total_cost: rawCost,
      };
    }
    return this;
  }

  /**
   * Set successful outcome
   */
  setSuccess(): this {
    this.event.outcome = "success";
    this.event.status_code = 200;
    return this;
  }

  /**
   * Set aborted outcome
   */
  setAborted(): this {
    this.event.outcome = "aborted";
    this.event.status_code = 200;
    return this;
  }

  /**
   * Set error outcome
   */
  setError(error: {
    type: string;
    code?: string;
    message: string;
    statusCode: number;
    retriable?: boolean;
  }): this {
    this.event.outcome = "error";
    this.event.status_code = error.statusCode;
    this.event.error = {
      type: error.type,
      code: error.code,
      message: error.message,
      retriable: error.retriable ?? false,
    };
    return this;
  }

  /**
   * Build and return the final wide event
   */
  build(): ChatWideEvent {
    // Add tool call count
    if (this.toolCalls.length > 0) {
      this.event.tool_call_count = this.toolCalls.length;
    }

    // Use provider cost if available, otherwise calculate from tokens
    if (this.event.usage && this.event.usage.total_cost === undefined) {
      // Fallback: calculate from tokens (pricing: $0.50/M input, $3.00/M output)
      const inputCost =
        ((this.event.usage.input_tokens || 0) / 1_000_000) * 0.5;
      const outputCost =
        ((this.event.usage.output_tokens || 0) / 1_000_000) * 3.0;
      this.event.usage.total_cost = inputCost + outputCost;
    }

    // Don't include assistant_id for temporary chats
    if (this.event.is_temporary) {
      delete this.event.assistant_id;
    }

    return this.event as ChatWideEvent;
  }
}

/**
 * Logger utility for emitting wide events
 */
export const logger = {
  /**
   * Log a wide event for a chat/agent request
   * Uses console.log with JSON for structured output that can be parsed by log aggregators
   */
  info(event: ChatWideEvent): void {
    // In production, log as JSON for structured logging
    // Log aggregators (Datadog, Splunk, etc.) can parse this
    console.log(JSON.stringify(event));
  },

  /**
   * Log a warning (for non-fatal issues)
   */
  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(
      JSON.stringify({
        level: "warn",
        message,
        timestamp: new Date().toISOString(),
        ...context,
      }),
    );
  },

  /**
   * Log an error (for debugging, separate from wide event error field)
   */
  error(
    message: string,
    error?: Error,
    context?: Record<string, unknown>,
  ): void {
    console.error(
      JSON.stringify({
        level: "error",
        message,
        timestamp: new Date().toISOString(),
        error: error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
          : undefined,
        ...context,
      }),
    );
  },
};

/**
 * Create a new wide event builder for a chat request
 */
export function createWideEventBuilder(
  chatId: string,
  endpoint: "/api/chat" | "/api/agent" | "/api/agent-long",
): WideEventBuilder {
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return new WideEventBuilder(requestId, chatId, endpoint);
}
