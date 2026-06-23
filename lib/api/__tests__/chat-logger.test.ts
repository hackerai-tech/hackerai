import { describe, expect, it, jest } from "@jest/globals";

(globalThis as any).Request = class Request {};
(globalThis as any).Response = class Response {};
(globalThis as any).Headers = class Headers {};

const {
  createChatLogger,
  captureAgentCompletionAnalytics,
  captureAgentRun,
  captureFreeAgentValueReached,
  captureToolCalls,
  captureUsageCost,
} = require("../chat-logger");
const { ChatSDKError } = require("../../errors");
const { phLogger } = require("../../posthog/server");

describe("captureToolCalls", () => {
  it("aggregates repeated tool calls by tool before sending PostHog events", () => {
    const capture = jest.fn();
    const posthog = { capture };
    const chatLogger = {
      getToolCalls: () => [
        { name: "run_terminal_cmd", sandbox_type: "e2b" },
        { name: "run_terminal_cmd", sandbox_type: "e2b" },
        { name: "open_url" },
        { name: "run_terminal_cmd", sandbox_type: "remote-connection" },
      ],
    };

    captureToolCalls({
      posthog: posthog as any,
      chatLogger: chatLogger as any,
      userId: "user_123",
      mode: "agent",
    });

    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledWith({
      distinctId: "user_123",
      event: "hackerai-tool_usage",
      properties: {
        mode: "agent",
        toolName: "run_terminal_cmd",
        count: 3,
        toolCallCount: 3,
      },
    });
    expect(capture).toHaveBeenCalledWith({
      distinctId: "user_123",
      event: "hackerai-tool_usage",
      properties: {
        mode: "agent",
        toolName: "open_url",
        count: 1,
        toolCallCount: 1,
      },
    });
  });

  it("does nothing when there are no recorded tool calls", () => {
    const capture = jest.fn();

    captureToolCalls({
      posthog: { capture } as any,
      chatLogger: { getToolCalls: () => [] } as any,
      userId: "user_123",
      mode: "agent",
    });

    expect(capture).not.toHaveBeenCalled();
  });
});

describe("captureAgentRun", () => {
  it("captures one sanitized agent run event with sandbox type", () => {
    const capture = jest.fn();

    captureAgentRun({
      posthog: { capture } as any,
      userId: "user_123",
      mode: "agent",
      subscription: "pro",
      sandboxInfo: { type: "remote-connection", name: "Work laptop" },
      outcome: "success",
    });

    expect(capture).toHaveBeenCalledWith({
      distinctId: "user_123",
      event: "hackerai-agent_run",
      properties: {
        mode: "agent",
        subscription: "pro",
        subscription_tier: "pro",
        outcome: "success",
        deep_mode_enabled: false,
        sandboxType: "remote-connection",
        sandbox_type: "remote-connection",
      },
    });
  });

  it("does not capture agent run events for ask mode", () => {
    const capture = jest.fn();

    captureAgentRun({
      posthog: { capture } as any,
      userId: "user_123",
      mode: "ask",
      subscription: "pro",
      sandboxInfo: { type: "e2b" },
      outcome: "success",
    });

    expect(capture).not.toHaveBeenCalled();
  });
});

describe("captureFreeAgentValueReached", () => {
  it("captures a free successful agent value event with user properties", () => {
    const capture = jest.fn();

    captureFreeAgentValueReached({
      posthog: { capture } as any,
      userId: "user_123",
      chatId: "chat_123",
      endpoint: "/api/agent-long",
      mode: "agent",
      subscription: "free",
      sandboxInfo: { type: "e2b" },
      outcome: "success",
      chatLogger: {
        getToolCalls: () => [{ name: "web_search" }, { name: "open_url" }],
      } as any,
    });

    expect(capture).toHaveBeenCalledWith({
      distinctId: "user_123",
      event: "hackerai-free_agent_value_reached",
      properties: expect.objectContaining({
        user_id: "user_123",
        chat_id: "chat_123",
        endpoint: "/api/agent-long",
        mode: "agent",
        subscription: "free",
        subscription_tier: "free",
        outcome: "success",
        deep_mode_enabled: false,
        tool_call_count: 2,
        agent_value_event_version: 1,
        sandbox_type: "e2b",
        $set_once: expect.objectContaining({
          first_free_agent_value_reached_at: expect.any(String),
        }),
        $set: expect.objectContaining({
          subscription_tier: "free",
          last_free_agent_value_reached_at: expect.any(String),
        }),
      }),
    });
  });

  it("does not capture for paid, ask mode, or unsuccessful runs", () => {
    const capture = jest.fn();
    const baseArgs = {
      posthog: { capture } as any,
      userId: "user_123",
      chatId: "chat_123",
      endpoint: "/api/agent-long" as const,
      mode: "agent" as const,
      subscription: "free",
      sandboxInfo: { type: "e2b" },
      outcome: "success" as const,
      chatLogger: { getToolCalls: () => [] } as any,
    };

    captureFreeAgentValueReached({
      ...baseArgs,
      subscription: "pro",
    });
    captureFreeAgentValueReached({
      ...baseArgs,
      mode: "ask",
    });
    captureFreeAgentValueReached({
      ...baseArgs,
      outcome: "aborted",
    });
    captureFreeAgentValueReached({
      ...baseArgs,
      outcome: "error",
    });

    expect(capture).not.toHaveBeenCalled();
  });
});

describe("captureAgentCompletionAnalytics", () => {
  it("captures both agent completion and free value events for successful free agent runs", () => {
    const capture = jest.fn();

    captureAgentCompletionAnalytics({
      posthog: { capture } as any,
      userId: "user_123",
      chatId: "chat_123",
      endpoint: "/api/agent-long",
      mode: "agent",
      subscription: "free",
      sandboxInfo: { type: "e2b" },
      outcome: "success",
      chatLogger: { getToolCalls: () => [{ name: "web_search" }] } as any,
    });

    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledWith({
      distinctId: "user_123",
      event: "hackerai-agent_run",
      properties: {
        mode: "agent",
        subscription: "free",
        subscription_tier: "free",
        outcome: "success",
        deep_mode_enabled: false,
        sandboxType: "e2b",
        sandbox_type: "e2b",
      },
    });
    expect(capture).toHaveBeenCalledWith({
      distinctId: "user_123",
      event: "hackerai-free_agent_value_reached",
      properties: expect.objectContaining({
        user_id: "user_123",
        chat_id: "chat_123",
        endpoint: "/api/agent-long",
        subscription_tier: "free",
        outcome: "success",
        deep_mode_enabled: false,
        tool_call_count: 1,
      }),
    });
  });

  it("keeps paid agent runs on the existing completion event only", () => {
    const capture = jest.fn();

    captureAgentCompletionAnalytics({
      posthog: { capture } as any,
      userId: "user_123",
      chatId: "chat_123",
      endpoint: "/api/agent-long",
      mode: "agent",
      subscription: "pro",
      sandboxInfo: { type: "e2b" },
      outcome: "success",
      chatLogger: { getToolCalls: () => [{ name: "web_search" }] } as any,
    });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith({
      distinctId: "user_123",
      event: "hackerai-agent_run",
      properties: {
        mode: "agent",
        subscription: "pro",
        subscription_tier: "pro",
        outcome: "success",
        deep_mode_enabled: false,
        sandboxType: "e2b",
        sandbox_type: "e2b",
      },
    });
  });

  it("captures Deep mode state on paid agent completion events", () => {
    const capture = jest.fn();

    captureAgentCompletionAnalytics({
      posthog: { capture } as any,
      userId: "user_123",
      chatId: "chat_123",
      endpoint: "/api/agent-long",
      mode: "agent",
      subscription: "pro",
      sandboxInfo: { type: "e2b" },
      outcome: "success",
      chatLogger: { getToolCalls: () => [] } as any,
      deepModeEnabled: true,
    });

    expect(capture).toHaveBeenCalledWith({
      distinctId: "user_123",
      event: "hackerai-agent_run",
      properties: {
        mode: "agent",
        subscription: "pro",
        subscription_tier: "pro",
        outcome: "success",
        deep_mode_enabled: true,
        sandboxType: "e2b",
        sandbox_type: "e2b",
      },
    });
  });
});

describe("captureUsageCost", () => {
  it("captures a user-scoped cost event with queryable dollar fields", () => {
    const capture = jest.fn();

    captureUsageCost({
      posthog: { capture } as any,
      userId: "user_123",
      subscription: "pro",
      organizationId: "org_123",
      chatId: "chat_123",
      endpoint: "/api/chat",
      mode: "agent",
      usage: {
        model: "claude-sonnet",
        type: "extra",
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cacheReadTokens: 200,
        cacheWriteTokens: undefined,
        costDollars: 0.42,
        includedCostDollars: 0.1,
        extraUsageCostDollars: 0.32,
        includedPointsDeducted: 1000,
        extraUsagePointsDeducted: 3200,
        modelCostDollars: 0.3,
        nonModelCostDollars: 0.12,
        costSource: "provider",
      },
      paidDailyFreeAllowance: {
        active: true,
        cutOff: false,
        requestLimit: 1,
        costLimitDollars: 0.25,
        resetTimestamp: 1_800_000_000_000,
      },
    });

    expect(capture).toHaveBeenCalledWith({
      distinctId: "user_123",
      event: "hackerai-usage_cost",
      properties: expect.objectContaining({
        user_id: "user_123",
        subscription: "pro",
        subscription_tier: "pro",
        organization_id: "org_123",
        chat_id: "chat_123",
        endpoint: "/api/chat",
        mode: "agent",
        model: "claude-sonnet",
        usage_type: "extra",
        cost_dollars: 0.42,
        included_cost_dollars: 0.1,
        extra_usage_cost_dollars: 0.32,
        included_points_deducted: 1000,
        extra_usage_points_deducted: 3200,
        model_cost_dollars: 0.3,
        non_model_cost_dollars: 0.12,
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
        cache_read_tokens: 200,
        cache_write_tokens: 0,
        cost_source: "provider",
        limit_rescue_type: "paid_daily_free_allowance",
        paid_daily_free_allowance_active: true,
        paid_daily_free_allowance_cut_off: false,
        paid_daily_free_allowance_request_limit: 1,
        paid_daily_free_allowance_cost_limit_dollars: 0.25,
        paid_daily_free_allowance_reset_timestamp: 1_800_000_000_000,
        $set: expect.objectContaining({
          subscription_tier: "pro",
          last_usage_cost_at: expect.any(String),
        }),
      }),
    });
  });
});

describe("createChatLogger provider stream termination", () => {
  it("logs provider safety blocks as errors with provider and model context", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const phErrorSpy = jest
      .spyOn(phLogger, "error")
      .mockImplementation(() => {});

    try {
      const chatLogger = createChatLogger({
        chatId: "chat_content_blocked",
        endpoint: "/api/chat",
      });
      const err = Object.assign(
        new Error("Output blocked by content filtering policy"),
        {
          statusCode: 403,
          responseBody: JSON.stringify({
            id: "gen-content-blocked",
            error: {
              code: 403,
              message: "Provider returned error",
              metadata: {
                provider_name: "Anthropic Vertex",
                raw: "Output blocked by content filtering policy",
              },
            },
          }),
        },
      );

      chatLogger.recordProviderError(err, {
        mode: "ask",
        model: "ask-model-free",
        requestedModelSlug: "deepseek/deepseek-v4-flash",
      });
      chatLogger.emitUnexpectedError(err);

      const warnOutput = warnSpy.mock.calls.flat().map(String).join("\n");
      const errorOutput = errorSpy.mock.calls.flat().map(String).join("\n");
      const wideEvent = JSON.parse(String(logSpy.mock.calls[0][0]));

      expect(warnOutput).not.toContain("Provider content blocked");
      expect(errorOutput).toContain("Provider content blocked");
      expect(errorOutput).toContain("provider_content_blocked");
      expect(errorOutput).toContain('"provider_name":"Anthropic Vertex"');
      expect(errorOutput).toContain('"configured_model":"ask-model-free"');
      expect(errorOutput).toContain(
        '"requested_model_slug":"deepseek/deepseek-v4-flash"',
      );
      expect(phErrorSpy).toHaveBeenCalledWith(
        "Provider content blocked",
        expect.objectContaining({
          event: "provider_content_blocked",
          providerErrorCategory: "content_blocked",
          provider_name: "Anthropic Vertex",
          provider_name_source: "openrouter_error_metadata",
          configured_model: "ask-model-free",
          requested_model_slug: "deepseek/deepseek-v4-flash",
          model_provider_slug: "deepseek",
          openrouter_generation_id: "gen-content-blocked",
        }),
      );
      expect(wideEvent.error).toMatchObject({
        type: "ProviderContentBlocked",
        retriable: false,
      });
      expect(wideEvent.provider_error).toMatchObject({
        category: "content_blocked",
        status_code: 403,
        retriable: false,
        provider_name: "Anthropic Vertex",
        provider_name_source: "openrouter_error_metadata",
        configured_model: "ask-model-free",
        requested_model_slug: "deepseek/deepseek-v4-flash",
        model_provider_slug: "deepseek",
        openrouter_generation_id: "gen-content-blocked",
      });
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
      phErrorSpy.mockRestore();
    }
  });

  it("logs terminated provider streams as warnings and suppresses duplicate unexpected route errors", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      const chatLogger = createChatLogger({
        chatId: "chat_terminated",
        endpoint: "/api/agent-long",
      });
      const err = Object.assign(new TypeError("terminated"), {
        cause: "other side closed",
      });

      chatLogger.recordProviderError(err, {
        mode: "agent",
        model: "agent-model",
        requestedModelSlug: "moonshotai/kimi-k2.7-code:exacto",
      });
      chatLogger.emitUnexpectedError(err);

      const warnOutput = warnSpy.mock.calls.flat().map(String).join("\n");
      const errorOutput = errorSpy.mock.calls.flat().map(String).join("\n");
      const wideEvents = logSpy.mock.calls.flat().map(String).join("\n");

      expect(warnOutput).toContain("Provider stream terminated");
      expect(warnOutput).toContain("provider_stream_terminated");
      expect(errorOutput).not.toContain("Unexpected error in chat route");
      expect(errorOutput).not.toContain("Provider streaming error");
      expect(wideEvents).toContain('"type":"ProviderStreamTerminated"');
      expect(wideEvents).toContain('"category":"stream_terminated"');
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("attaches sanitized provider request diagnostics to provider errors", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      const chatLogger = createChatLogger({
        chatId: "chat_provider_shape",
        endpoint: "/api/agent-long",
      });
      const providerRequest = {
        model: "model-opus-4.6",
        requested_model_slug: "anthropic/claude-opus-4.6",
        step_index: 4,
        source: "prepare_step",
        message_count: 9,
        role_counts: { user: 5, assistant: 4 },
        content_part_counts: { text: 6, "tool-result": 3 },
        last_message_role: "user",
        last_message_content_types: ["tool-result"],
        serialized_message_bytes: 680000,
        estimated_serialized_message_tokens: 170000,
        context_used_tokens: 171844,
        context_max_tokens: 200000,
        context_used_percent: 85.9,
        system_tokens: 12000,
        max_output_tokens: 64000,
        tool_count: 12,
        active_tool_count: 12,
        active_tools_mode: "all",
        reasoning_enabled: true,
        fallback_model_count: 2,
        fallback_model_slugs: ["google/gemini-3.5-flash", "x-ai/grok-4.3"],
        has_user_attribution: true,
        has_multimodal_tool_results: true,
      };
      const err = {
        message: "Provider request failed",
        responseBody: JSON.stringify({
          error: {
            code: 502,
            message: "Invalid arguments passed to the model.",
          },
        }),
        requestBodyValues: {
          messages: [{ role: "user", content: "SECRET_PROMPT_TEXT" }],
        },
      };

      chatLogger.recordProviderRequestDiagnostics(providerRequest);
      chatLogger.recordProviderError(err, {
        mode: "agent",
        model: "model-opus-4.6",
        requestedModelSlug: "anthropic/claude-opus-4.6",
        providerRequest,
      });
      chatLogger.emitUnexpectedError(err);

      const wideEvent = JSON.parse(String(logSpy.mock.calls[0][0]));
      expect(wideEvent.provider_request).toMatchObject({
        step_index: 4,
        message_count: 9,
        estimated_serialized_message_tokens: 170000,
        content_part_counts: { text: 6, "tool-result": 3 },
      });
      expect(wideEvent.provider_error).not.toHaveProperty("request");
      expect(JSON.stringify(wideEvent)).not.toContain("SECRET_PROMPT_TEXT");
      expect(errorSpy.mock.calls.flat().map(String).join("\n")).not.toContain(
        "SECRET_PROMPT_TEXT",
      );
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("logs nested provider raw errors for generic 400 provider wrappers", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      const chatLogger = createChatLogger({
        chatId: "chat_provider_wrapper",
        endpoint: "/api/chat",
      });
      const nestedProviderError = Object.assign(
        new Error("Provider request failed"),
        {
          name: "AI_APICallError",
          statusCode: 400,
          responseBody: JSON.stringify({
            id: "gen-400-wrapper",
            error: {
              code: 400,
              message: "Provider returned error",
              metadata: {
                provider_name: "Anthropic",
                raw: "tool_result without corresponding tool_use",
              },
            },
          }),
          requestBodyValues: {
            messages: [{ role: "user", content: "SECRET_PROMPT_TEXT" }],
          },
          isRetryable: false,
        },
      );
      const err = {
        message: "Provider returned error",
        code: 400,
        error: nestedProviderError,
      };

      chatLogger.recordProviderError(err, {
        mode: "ask",
        model: "model-opus-4.6",
        requestedModelSlug: "anthropic/claude-opus-4.6",
      });
      chatLogger.emitUnexpectedError(err);

      const providerErrorOutput = errorSpy.mock.calls
        .flat()
        .map(String)
        .join("\n");
      const wideEvent = JSON.parse(String(logSpy.mock.calls[0][0]));

      expect(providerErrorOutput).toContain(
        '"provider_error_category":"provider_4xx"',
      );
      expect(providerErrorOutput).toContain(
        '"providerRawError":"tool_result without corresponding tool_use"',
      );
      expect(providerErrorOutput).not.toContain("SECRET_PROMPT_TEXT");
      expect(wideEvent.provider_error).toMatchObject({
        category: "provider_4xx",
        status_code: 400,
        message: "tool_result without corresponding tool_use",
        retriable: false,
      });
      expect(JSON.stringify(wideEvent)).not.toContain("SECRET_PROMPT_TEXT");
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("enriches PostHog exception messages for Error provider failures", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const chatLogger = createChatLogger({
        chatId: "chat_provider_error_instance",
        endpoint: "/api/chat",
      });
      const providerError = Object.assign(
        new Error("Provider request failed"),
        {
          name: "AI_APICallError",
          statusCode: 400,
          responseBody: JSON.stringify({
            id: "gen-error-instance",
            error: {
              code: 400,
              message: "Provider returned error",
              metadata: {
                provider_name: "Anthropic",
                raw: "tool_result without corresponding tool_use",
              },
            },
          }),
        },
      );

      chatLogger.recordProviderError(providerError, {
        mode: "ask",
        model: "model-opus-4.6",
        requestedModelSlug: "anthropic/claude-opus-4.6",
      });

      const posthogErrorCall = errorSpy.mock.calls.find(
        (call) =>
          call[0] === "Provider streaming error" &&
          typeof call[1] === "object" &&
          call[1] !== null,
      );
      const fields = posthogErrorCall?.[1] as { error?: unknown } | undefined;
      const capturedError = fields?.error as
        | (Error & { cause?: unknown })
        | undefined;

      expect(capturedError).toBeInstanceOf(Error);
      expect(capturedError?.name).toBe("AI_APICallError");
      expect(capturedError?.message).toBe(
        "tool_result without corresponding tool_use",
      );
      expect(capturedError?.cause).toBe(providerError);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("createChatLogger ChatSDKError metadata", () => {
  it("keeps wide event error metadata compact and drops bulky nested diagnostics", () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      const chatLogger = createChatLogger({
        chatId: "chat_missing",
        endpoint: "/api/agent-long",
      });
      const err = new ChatSDKError(
        "not_found:chat",
        "Chat no longer exists while saving message",
        {
          db_operation: "messages.saveMessage",
          db_error_name: "ConvexError",
          db_error_message: "[Request ID: abc] Server Error",
          db_error_code: "CHAT_NOT_FOUND",
          db_failure_stage: "verify_chat_ownership",
          db_error_data: {
            code: "MESSAGE_SAVE_FAILED",
            causeData: {
              code: "CHAT_NOT_FOUND",
              message: "This chat doesn't exist",
            },
          },
          part_types: {
            reasoning: 90,
            "tool-run_terminal_cmd": 74,
          },
          usage_keys: ["inputTokens", "outputTokens"],
          parts_size_bytes: 564266,
          parts_size_kb: 551,
          part_count: 288,
          tool_part_count: 99,
          empty_after_processing: true,
          processing_input_message_count: 2,
          processing_input_part_count: 4,
          processing_input_text_part_count: 1,
          processing_input_nonempty_text_part_count: 0,
          processing_input_ui_only_part_count: 1,
          processing_input_regenerate: false,
          processing_input_sandbox_preference: "desktop",
          processing_input_part_types: {
            text: 1,
            "data-summarization": 1,
          },
        },
      );

      chatLogger.emitChatError(err);

      const wideEvent = JSON.parse(String(logSpy.mock.calls[0][0]));
      expect(wideEvent.error.metadata).toEqual({
        db_operation: "messages.saveMessage",
        db_error_name: "ConvexError",
        db_error_message: "[Request ID: abc] Server Error",
        db_error_code: "CHAT_NOT_FOUND",
        db_failure_stage: "verify_chat_ownership",
        parts_size_kb: 551,
        part_count: 288,
        tool_part_count: 99,
        empty_after_processing: true,
        processing_input_message_count: 2,
        processing_input_part_count: 4,
        processing_input_text_part_count: 1,
        processing_input_nonempty_text_part_count: 0,
        processing_input_ui_only_part_count: 1,
        processing_input_regenerate: false,
        processing_input_sandbox_preference: "desktop",
      });
      expect(wideEvent.error.metadata).not.toHaveProperty("db_error_data");
      expect(wideEvent.error.metadata).not.toHaveProperty("part_types");
      expect(wideEvent.error.metadata).not.toHaveProperty("usage_keys");
      expect(wideEvent.error.metadata).not.toHaveProperty("parts_size_bytes");
      expect(wideEvent.error.metadata).not.toHaveProperty(
        "processing_input_part_types",
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("emits limit pressure funnel properties for paid monthly exhaustion", () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const eventSpy = jest.spyOn(phLogger, "event").mockImplementation(() => {});

    try {
      const chatLogger = createChatLogger({
        chatId: "chat_limit",
        endpoint: "/api/chat",
      });
      chatLogger.setRequestDetails({
        mode: "agent",
        isTemporary: false,
        isRegenerate: false,
      });
      chatLogger.setUser({ id: "user_123", subscription: "pro" });
      chatLogger.setRateLimit(
        {
          subscription: "pro",
          monthly: { remaining: 0, limit: 250_000 },
        },
        undefined,
      );

      chatLogger.emitChatError(
        new ChatSDKError("rate_limit:chat", "Monthly limit hit", {
          capReason: "monthly_exhausted",
          resetTimestamp: 1_800_000_000_000,
          paidDailyFreeAllowance: {
            type: "paid_daily_free_allowance",
            available: true,
            requestsRemaining: 1,
            requestLimit: 1,
            costRemainingDollars: 0.25,
            costLimitDollars: 0.25,
            rolloutPercent: 10,
          },
        }),
      );

      expect(eventSpy).toHaveBeenCalledWith(
        "limit_hit",
        expect.objectContaining({
          subscription_tier: "pro",
          limit_type: "monthly",
          cap_reason: "monthly_exhausted",
          paid_monthly_exhaustion: true,
          add_credit_available: true,
          primary_cta: "add_credits",
          eligible_ctas: ["add_credits", "upgrade_plan"],
          paid_daily_free_allowance_available: true,
          paid_daily_free_allowance_requests_remaining: 1,
          paid_daily_free_allowance_request_limit: 1,
          paid_daily_free_allowance_cost_remaining_dollars: 0.25,
          paid_daily_free_allowance_cost_limit_dollars: 0.25,
          paid_daily_free_allowance_rollout_percent: 10,
          chat_id: "chat_limit",
        }),
      );
      expect(eventSpy).toHaveBeenCalledWith(
        "monthly_cap_hit",
        expect.objectContaining({
          subscription: "pro",
          cap_reason: "monthly_exhausted",
          primary_cta: "add_credits",
          eligible_ctas: ["add_credits", "upgrade_plan"],
        }),
      );
    } finally {
      eventSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("does not emit monthly_cap_hit for paid billing service outages", () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const eventSpy = jest.spyOn(phLogger, "event").mockImplementation(() => {});

    try {
      const chatLogger = createChatLogger({
        chatId: "chat_billing_unavailable",
        endpoint: "/api/chat",
      });
      chatLogger.setRequestDetails({
        mode: "agent",
        isTemporary: false,
        isRegenerate: false,
      });
      chatLogger.setUser({ id: "user_123", subscription: "pro" });

      chatLogger.emitChatError(
        new ChatSDKError("rate_limit:chat", "Billing unavailable", {
          capReason: "billing_unavailable",
          resetTimestamp: 1_800_000_000_000,
        }),
      );

      expect(eventSpy).toHaveBeenCalledWith(
        "limit_hit",
        expect.objectContaining({
          cap_reason: "billing_unavailable",
          limit_type: "billing",
        }),
      );
      expect(eventSpy).not.toHaveBeenCalledWith(
        "monthly_cap_hit",
        expect.anything(),
      );
    } finally {
      eventSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe("createChatLogger OpenRouter metadata", () => {
  it("adds provider attribution fields to the wide event model block", () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      const chatLogger = createChatLogger({
        chatId: "chat_provider_metadata",
        endpoint: "/api/agent-long",
      });
      chatLogger.setRequestDetails({
        mode: "agent",
        isTemporary: false,
        isRegenerate: false,
      });
      chatLogger.setUser({ id: "user_123", subscription: "ultra" });
      chatLogger.setChat(
        {
          messageCount: 1,
          estimatedInputTokens: 100,
          isNewChat: false,
          notesEnabled: false,
        },
        "model-opus-4.6",
      );
      chatLogger.setStreamResponse(
        "anthropic/claude-opus-4.6",
        { inputTokens: 100, outputTokens: 1 },
        {
          provider_name: "Anthropic Vertex",
          openrouter_generation_id: "gen-123",
          openrouter_request_id: "req-123",
          openrouter_strategy: "direct",
        },
      );
      chatLogger.emitSuccess({
        finishReason: "stop",
        wasAborted: false,
        wasPreemptiveTimeout: false,
        hadSummarization: false,
      });

      const wideEvent = JSON.parse(String(logSpy.mock.calls[0][0]));
      expect(wideEvent.model).toMatchObject({
        configured: "model-opus-4.6",
        actual: "anthropic/claude-opus-4.6",
        provider_name: "Anthropic Vertex",
        openrouter_generation_id: "gen-123",
        openrouter_request_id: "req-123",
        openrouter_strategy: "direct",
      });
      expect(wideEvent.model).not.toHaveProperty("provider_gateway");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("createChatLogger provider stream timeout", () => {
  it("logs upstream idle timeouts as provider timeout warnings with the provider message", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      const chatLogger = createChatLogger({
        chatId: "chat_timeout",
        endpoint: "/api/agent-long",
      });
      const err = {
        code: 502,
        message: "Upstream idle timeout exceeded",
      };

      chatLogger.recordProviderError(err, {
        mode: "agent",
        model: "agent-model",
        requestedModelSlug: "moonshotai/kimi-k2.7-code:exacto",
      });
      chatLogger.emitUnexpectedError(err);

      const warnOutput = warnSpy.mock.calls.flat().map(String).join("\n");
      const errorOutput = errorSpy.mock.calls.flat().map(String).join("\n");
      const wideEvents = logSpy.mock.calls.flat().map(String).join("\n");

      expect(warnOutput).toContain("Provider stream timeout");
      expect(warnOutput).toContain('"provider_error_category":"timeout"');
      expect(errorOutput).not.toContain("Unexpected error in chat route");
      expect(errorOutput).not.toContain("Provider streaming error");
      expect(wideEvents).toContain('"type":"ProviderTimeout"');
      expect(wideEvents).toContain(
        '"message":"Upstream idle timeout exceeded"',
      );
      expect(wideEvents).toContain('"retriable":true');
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("uses nested provider status codes in wide events", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      const chatLogger = createChatLogger({
        chatId: "chat_provider_code",
        endpoint: "/api/agent-long",
      });
      const err = {
        message: "Provider request failed",
        responseBody: JSON.stringify({
          error: {
            code: 502,
            message: "Provider overloaded",
          },
        }),
      };

      chatLogger.recordProviderError(err, {
        mode: "agent",
        model: "agent-model",
      });
      chatLogger.emitUnexpectedError(err);

      const wideEvent = JSON.parse(String(logSpy.mock.calls[0][0]));
      expect(wideEvent.status_code).toBe(502);
      expect(wideEvent.provider_error.status_code).toBe(502);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
