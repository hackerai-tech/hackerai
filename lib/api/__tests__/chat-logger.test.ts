import { describe, expect, it, jest } from "@jest/globals";

(globalThis as any).Request = class Request {};
(globalThis as any).Response = class Response {};
(globalThis as any).Headers = class Headers {};

const { captureAgentRun, captureToolCalls } = require("../chat-logger");

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
