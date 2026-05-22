import { describe, expect, it, jest } from "@jest/globals";

(globalThis as any).Request = class Request {};
(globalThis as any).Response = class Response {};
(globalThis as any).Headers = class Headers {};

const {
  createChatLogger,
  captureAgentRun,
  captureToolCalls,
  captureUsageCost,
} = require("../chat-logger");
const { ChatSDKError } = require("../../errors");

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
        outcome: "success",
        sandboxType: "remote-connection",
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
        modelCostDollars: 0.3,
        nonModelCostDollars: 0.12,
        costSource: "provider",
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
        model_cost_dollars: 0.3,
        non_model_cost_dollars: 0.12,
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
        cache_read_tokens: 200,
        cache_write_tokens: 0,
        cost_source: "provider",
        $set: expect.objectContaining({
          subscription_tier: "pro",
          last_usage_cost_at: expect.any(String),
        }),
      }),
    });
  });
});

describe("createChatLogger provider stream termination", () => {
  it("logs terminated provider streams as warnings and suppresses duplicate unexpected route errors", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      const chatLogger = createChatLogger({
        chatId: "chat_terminated",
        endpoint: "/api/agent",
      });
      const err = Object.assign(new TypeError("terminated"), {
        cause: "other side closed",
      });

      chatLogger.recordProviderError(err, {
        mode: "agent",
        model: "agent-model",
        requestedModelSlug: "moonshotai/kimi-k2.6:exacto",
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
});

describe("createChatLogger ChatSDKError metadata", () => {
  it("keeps wide event error metadata compact and drops bulky nested diagnostics", () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      const chatLogger = createChatLogger({
        chatId: "chat_missing",
        endpoint: "/api/agent",
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
      });
      expect(wideEvent.error.metadata).not.toHaveProperty("db_error_data");
      expect(wideEvent.error.metadata).not.toHaveProperty("part_types");
      expect(wideEvent.error.metadata).not.toHaveProperty("usage_keys");
      expect(wideEvent.error.metadata).not.toHaveProperty("parts_size_bytes");
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
        endpoint: "/api/agent",
      });
      const err = {
        code: 502,
        message: "Upstream idle timeout exceeded",
      };

      chatLogger.recordProviderError(err, {
        mode: "agent",
        model: "agent-model",
        requestedModelSlug: "moonshotai/kimi-k2.6:exacto",
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
});
