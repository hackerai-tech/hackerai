/**
 * Wide Event Logger
 *
 * Implements the wide event logging pattern for comprehensive request observability.
 * One event per request with all context, emitted at the end of the request lifecycle.
 *
 * @see docs/logging-best-practices.md
 */

import type { ChatMode, ExtraUsageConfig } from "@/types";
import type { OpenRouterModelMetadata } from "@/lib/api/openrouter-metadata";

export interface ProviderRequestDiagnostics {
  model: string;
  requested_model_slug?: string;
  step_index: number;
  source: "initial" | "prepare_step" | "summarized_prepare_step";
  message_count: number;
  role_counts: Record<string, number>;
  content_part_counts: Record<string, number>;
  last_message_role?: string;
  last_message_content_types?: string[];
  trailing_assistant_has_tool_call?: boolean;
  serialized_message_bytes?: number;
  estimated_serialized_message_tokens?: number;
  context_used_tokens: number;
  context_max_tokens: number;
  context_used_percent: number;
  system_tokens: number;
  max_output_tokens: number;
  tool_count: number;
  active_tool_count: number;
  active_tools_mode: "all" | "subset";
  reasoning_enabled?: boolean;
  reasoning_effort?: string;
  fallback_model_count: number;
  fallback_model_slugs?: string[];
  has_user_attribution: boolean;
  has_multimodal_tool_results: boolean;
}

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
  service: "chat-handler";
  endpoint: "/api/chat" | "/api/agent-long";
  version: string;
  region?: string;

  // Request details
  mode: ChatMode;
  is_temporary: boolean;
  is_regenerate: boolean;

  // User context
  user: {
    id: string;
    subscription: string;
  };

  // Business context
  chat: {
    message_count: number;
    estimated_input_tokens: number;
    is_new_chat: boolean;
    file_count?: number;
    image_count?: number;
    notes_enabled: boolean;
  };

  // Extra usage context (paid users)
  extra_usage?: {
    enabled?: boolean;
    has_balance?: boolean;
    balance_dollars?: number;
    monthly_cap_dollars?: number;
    monthly_spent_dollars?: number;
    monthly_remaining_dollars?: number;
    auto_reload_enabled?: boolean;
  };

  // Rate limit context
  rate_limit?: {
    points_deducted?: number;
    extra_usage_points_deducted?: number;
    monthly_remaining_percent?: number;
    free_remaining?: number;
  };

  // Model & generation
  model?: {
    configured: string;
    actual?: string;
    provider_name?: string;
    openrouter_generation_id?: string;
    openrouter_request_id?: string;
    openrouter_is_byok?: boolean;
    openrouter_router?: string;
    openrouter_strategy?: string;
    openrouter_region?: string;
    openrouter_attempt?: number;
    openrouter_upstream_id?: string;
    openrouter_selected_model?: string;
    openrouter_attempts?: OpenRouterModelMetadata["openrouter_attempts"];
    fallback_triggered?: boolean;
    fallback_chain?: string[];
  };

  prompt_repair?: {
    anthropic?: {
      count: number;
      last_action: "appended_continue" | "trimmed";
      last_reason:
        | "useful_assistant_tail"
        | "no_useful_content"
        | "dangling_tool_call";
      last_content_types?: string[];
    };
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
    cache_hit_rate?: number;
    total_cost?: number;
  };

  // Sandbox execution
  sandbox?: {
    type: "e2b" | "desktop" | "remote-connection";
    name?: string;
  };

  // Sandbox boot timing — fires once per request, only when actual work is done
  // (not set when the sandbox was already cached/passed via initialSandbox)
  sandbox_boot?: {
    path:
      | "reuse_existing"
      | "create_fresh"
      | "create_after_version_mismatch"
      | "create_after_expired"
      | "create_after_broken";
    duration_ms: number;
    create_attempts: number;
  };

  // Caido proxy setup timing — captures the first non-locked_wait ensureCaido call
  // within a request. Subsequent calls in the same request await the same lock and
  // are not recorded (they measure wait time, not setup cost).
  caido?: {
    path:
      | "fast"
      | "needs_start"
      | "external"
      | "locked_wait"
      | "locked_wait_error"
      | "cached_ready"
      | "windows_unsupported"
      | "setup_error";
    duration_ms: number;
    initial_script_ms?: number;
    background_start_ms?: number;
    health_poll_ms?: number;
    reauth_script_ms?: number;
    /** Bounded error kind — raw messages stay in debug-only console.warn. */
    error_kind?:
      | "install_failed"
      | "start_timeout"
      | "auth_failed"
      | "external_unreachable"
      | "setup_failed"
      | "unknown";
  };

  // Tool execution
  tool_call_count?: number;

  // Sanitized shape of the most recent model request prepared for the provider.
  // Never contains prompt text, tool arguments, file contents, or user ids.
  provider_request?: ProviderRequestDiagnostics;

  // Outcome. `partial` means the request returned 200 but the provider stream
  // errored — either we recovered via fallback or we sent an error chunk to
  // the client. Distinguishing this from `success` keeps dashboards honest.
  outcome: "success" | "partial" | "error" | "aborted";
  status_code: number;

  // Error details (if any)
  error?: {
    type: string;
    code?: string;
    message: string;
    cause?: string;
    retriable: boolean;
    metadata?: Record<string, unknown>;
  };

  // True when the provider stream errored (e.g., AI_RetryError) but the
  // request still resolved end-to-end — distinguishes a clean success from
  // one where the model leg died and we recovered (fallback, partial output).
  had_provider_error?: boolean;
  provider_error?: {
    category?: string;
    status_code?: number;
    url?: string;
    reason?: string;
    message?: string;
    retriable?: boolean;
    provider_name?: string;
    provider_name_source?: string;
    configured_model?: string;
    requested_model_slug?: string;
    model_provider_slug?: string;
    openrouter_generation_id?: string;
    // Per-attempt breakdown when the SDK retried internally. Each entry is one
    // upstream call. Lets you tell consistent-500 from a mixed cascade and
    // gives you provider request IDs to file support tickets with.
    attempts?: Array<{
      status_code?: number;
      message: string;
      error_name?: string;
      request_id?: string;
      provider_name?: string;
    }>;
  };
}

/**
 * Builder for constructing wide events throughout the request lifecycle
 */
export class WideEventBuilder {
  private event: Partial<ChatWideEvent>;
  private toolCalls: Array<{ name: string; sandbox_type?: string }> = [];
  private streamStartTime?: number;
  private anthropicPromptRepairCount = 0;

  constructor(
    requestId: string,
    chatId: string,
    endpoint: "/api/chat" | "/api/agent-long",
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
    isNewChat: boolean;
    fileCount?: number;
    imageCount?: number;
    notesEnabled: boolean;
  }): this {
    this.event.chat = {
      message_count: chat.messageCount,
      estimated_input_tokens: chat.estimatedInputTokens,
      is_new_chat: chat.isNewChat,
      file_count: chat.fileCount,
      image_count: chat.imageCount,
      notes_enabled: chat.notesEnabled,
    };
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
        monthly_cap_dollars: config.monthlyCapDollars,
        monthly_spent_dollars: config.monthlySpentDollars,
        monthly_remaining_dollars: config.monthlyRemainingDollars,
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
    monthlyRemainingPercent?: number;
    freeRemaining?: number;
  }): this {
    this.event.rate_limit = {
      points_deducted: info.pointsDeducted,
      extra_usage_points_deducted: info.extraUsagePointsDeducted,
      monthly_remaining_percent: info.monthlyRemainingPercent,
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
   * Attach OpenRouter routing/provider metadata to the model block.
   */
  setOpenRouterMetadata(metadata: OpenRouterModelMetadata): this {
    if (!this.event.model) {
      this.event.model = {
        configured: metadata.openrouter_selected_model ?? "",
      };
    }

    this.event.model = {
      ...this.event.model,
      ...metadata,
    };

    return this;
  }

  /**
   * Record that OpenRouter served a configured fallback model.
   */
  recordModelFallback(fallback: { served: string; chain: string[] }): this {
    if (!this.event.model) {
      this.event.model = { configured: fallback.served };
    }
    this.event.model.actual = fallback.served;
    this.event.model.fallback_triggered = true;
    this.event.model.fallback_chain = fallback.chain;
    return this;
  }

  /**
   * Record the sanitized shape of the latest provider request.
   */
  setProviderRequestDiagnostics(diagnostics: ProviderRequestDiagnostics): this {
    this.event.provider_request = diagnostics;
    return this;
  }

  /**
   * Record Anthropic prompt repairs that prevent unsupported assistant prefill.
   */
  recordAnthropicPromptRepair(repair: {
    action: "appended_continue" | "trimmed";
    reason:
      | "useful_assistant_tail"
      | "no_useful_content"
      | "dangling_tool_call";
    trailingAssistantContentTypes?: string[];
  }): this {
    this.anthropicPromptRepairCount += 1;
    this.event.prompt_repair = {
      ...this.event.prompt_repair,
      anthropic: {
        count: this.anthropicPromptRepairCount,
        last_action: repair.action,
        last_reason: repair.reason,
        last_content_types: repair.trailingAssistantContentTypes,
      },
    };
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
   * Record sandbox boot timing. First call wins — the first `ensureSandboxConnection`
   * that actually does work in a request is the meaningful measurement.
   */
  setSandboxBoot(boot: NonNullable<ChatWideEvent["sandbox_boot"]>): this {
    if (!this.event.sandbox_boot) {
      this.event.sandbox_boot = boot;
    }
    return this;
  }

  /**
   * Record Caido proxy setup timing. First call wins — subsequent `ensureCaido`
   * calls in the same request hit the lock and measure wait time, not setup cost.
   */
  setCaidoReady(caido: NonNullable<ChatWideEvent["caido"]>): this {
    if (!this.event.caido) {
      this.event.caido = caido;
    }
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
   * Get recorded tool calls
   */
  getToolCalls(): Array<{ name: string; sandbox_type?: string }> {
    return this.toolCalls;
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

  private additionalToolCost = 0;

  /**
   * Add external tool cost (in dollars) to be included in total_cost
   */
  addToolCost(costDollars: number): this {
    this.additionalToolCost += costDollars;
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
        reasoning_tokens: (usage.reasoningTokens as number) || undefined,
        cache_read_tokens: usage.cacheReadInputTokens as number | undefined,
        cache_write_tokens: usage.cacheCreationInputTokens as
          | number
          | undefined,
        total_cost: rawCost,
      };
    }
    return this;
  }

  /**
   * Set cache metrics from UsageTracker and warn on low hit rate
   */
  setCacheMetrics(metrics: {
    cacheHitRate: number | null;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }): this {
    // Don't create an empty usage object just for cache metrics — if setUsage
    // was never called (e.g. aborted request), skip to avoid build() backfilling
    // a spurious total_cost: 0.
    if (!this.event.usage) return this;

    // Always populate read/write tokens from UsageTracker (more reliable than
    // the raw provider fields that setUsage reads, which vary by provider)
    if (metrics.cacheReadTokens > 0) {
      this.event.usage.cache_read_tokens = metrics.cacheReadTokens;
    }
    if (metrics.cacheWriteTokens > 0) {
      this.event.usage.cache_write_tokens = metrics.cacheWriteTokens;
    }
    if (metrics.cacheHitRate !== null) {
      this.event.usage.cache_hit_rate =
        Math.round(metrics.cacheHitRate * 1000) / 1000;
    }

    // Warn on low cache hit rate (skip small requests where misses are expected)
    const totalCacheTokens = metrics.cacheReadTokens + metrics.cacheWriteTokens;
    if (
      metrics.cacheHitRate !== null &&
      metrics.cacheHitRate < 0.5 &&
      totalCacheTokens > 1000
    ) {
      logger.warn("Low cache hit rate detected", {
        cache_hit_rate: metrics.cacheHitRate,
        cache_read_tokens: metrics.cacheReadTokens,
        cache_write_tokens: metrics.cacheWriteTokens,
        chat_id: this.event.chat_id,
        model: this.event.model?.configured,
      });
    }
    return this;
  }

  /**
   * Set successful outcome. Downgrades to `partial` when the provider stream
   * errored mid-flight, so dashboards/alerts don't treat broken responses as
   * clean successes.
   */
  setSuccess(): this {
    this.event.outcome = this.event.had_provider_error ? "partial" : "success";
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
   * Mark that a provider error fired during the stream. Does not change
   * outcome — call setSuccess/setError separately based on overall result.
   */
  markProviderError(details: {
    category?: string;
    statusCode?: number;
    url?: string;
    reason?: string;
    message?: string;
    retriable?: boolean;
    providerName?: string;
    providerNameSource?: string;
    configuredModel?: string;
    requestedModelSlug?: string;
    modelProviderSlug?: string;
    openrouterGenerationId?: string;
    attempts?: NonNullable<ChatWideEvent["provider_error"]>["attempts"];
  }): this {
    this.event.had_provider_error = true;
    this.event.provider_error = {
      category: details.category,
      status_code: details.statusCode,
      url: details.url,
      reason: details.reason,
      message: details.message,
      retriable: details.retriable,
      provider_name: details.providerName,
      provider_name_source: details.providerNameSource,
      configured_model: details.configuredModel,
      requested_model_slug: details.requestedModelSlug,
      model_provider_slug: details.modelProviderSlug,
      openrouter_generation_id: details.openrouterGenerationId,
      attempts: details.attempts,
    };
    return this;
  }

  /**
   * Set error outcome
   */
  setError(error: {
    type: string;
    code?: string;
    message: string;
    cause?: string;
    statusCode: number;
    retriable?: boolean;
    metadata?: Record<string, unknown>;
  }): this {
    this.event.outcome = "error";
    this.event.status_code = error.statusCode;
    this.event.error = {
      type: error.type,
      code: error.code,
      message: error.message,
      cause: error.cause,
      retriable: error.retriable ?? false,
      metadata: error.metadata,
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
    if (this.event.usage && !this.event.usage.total_cost) {
      // Fallback: calculate from tokens (pricing: $0.50/M input, $3.00/M output)
      const inputCost =
        ((this.event.usage.input_tokens || 0) / 1_000_000) * 0.5;
      const outputCost =
        ((this.event.usage.output_tokens || 0) / 1_000_000) * 3.0;
      this.event.usage.total_cost = inputCost + outputCost;
    }

    // Add external tool costs (e.g., web search API)
    if (this.additionalToolCost > 0 && this.event.usage) {
      this.event.usage.total_cost =
        (this.event.usage.total_cost || 0) + this.additionalToolCost;
    }

    // Don't include assistant_id for temporary chats
    if (this.event.is_temporary) {
      delete this.event.assistant_id;
    }

    // Strip zero/undefined values from usage to reduce noise
    if (this.event.usage) {
      const u = this.event.usage;
      if (!u.reasoning_tokens) delete u.reasoning_tokens;
      if (!u.cache_read_tokens) delete u.cache_read_tokens;
      if (!u.cache_write_tokens) delete u.cache_write_tokens;
    }

    // Strip zero-value file counts from chat
    if (this.event.chat) {
      const c = this.event.chat;
      if (!c.file_count) delete c.file_count;
      if (!c.image_count) delete c.image_count;
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
  endpoint: "/api/chat" | "/api/agent-long",
): WideEventBuilder {
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return new WideEventBuilder(requestId, chatId, endpoint);
}
