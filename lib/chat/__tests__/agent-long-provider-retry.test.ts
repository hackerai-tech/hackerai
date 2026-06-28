import { shouldRetryAgentLongWithFallback } from "../agent-long-provider-retry";

describe("shouldRetryAgentLongWithFallback", () => {
  it("preserves the legacy retry for streams that only emitted step-start", () => {
    expect(
      shouldRetryAgentLongWithFallback([{ type: "step-start" }], {
        hasTerminalProviderStreamError: false,
      }),
    ).toBe(true);
  });

  it("retries terminal provider errors that emitted only reasoning", () => {
    expect(
      shouldRetryAgentLongWithFallback(
        [
          { type: "step-start" },
          { type: "reasoning", text: "thinking", state: "done" },
        ],
        { hasTerminalProviderStreamError: true },
      ),
    ).toBe(true);
  });

  it("does not treat leaked provider reasoning tags as visible output", () => {
    expect(
      shouldRetryAgentLongWithFallback(
        [
          { type: "step-start" },
          { type: "reasoning", text: "thinking", state: "done" },
          { type: "text", text: "</mm:think>" },
        ],
        { hasTerminalProviderStreamError: true },
      ),
    ).toBe(true);
  });

  it("allows hidden metadata around reasoning-only provider output", () => {
    expect(
      shouldRetryAgentLongWithFallback(
        [
          { type: "data-agent-heartbeat", data: { at: 1 } },
          { type: "step-start" },
          { type: "reasoning", text: "thinking", state: "done" },
          { type: "data-context-usage", data: { usedTokens: 100 } },
        ],
        { hasTerminalProviderStreamError: true },
      ),
    ).toBe(true);
  });

  it("does not retry reasoning-only output for a non-terminal provider stream", () => {
    expect(
      shouldRetryAgentLongWithFallback(
        [
          { type: "step-start" },
          { type: "reasoning", text: "thinking", state: "done" },
        ],
        { hasTerminalProviderStreamError: false },
      ),
    ).toBe(false);
  });

  it("does not discard visible text when a provider stream fails", () => {
    expect(
      shouldRetryAgentLongWithFallback(
        [
          { type: "step-start" },
          { type: "reasoning", text: "thinking", state: "done" },
          { type: "text", text: "visible answer" },
        ],
        { hasTerminalProviderStreamError: true },
      ),
    ).toBe(false);
  });

  it("does not discard tool calls or tool output when a provider stream fails", () => {
    expect(
      shouldRetryAgentLongWithFallback(
        [
          { type: "step-start" },
          {
            type: "tool-shell",
            toolCallId: "call_1",
            state: "output-available",
          },
        ],
        { hasTerminalProviderStreamError: true },
      ),
    ).toBe(false);

    expect(
      shouldRetryAgentLongWithFallback(
        [
          { type: "step-start" },
          { type: "data-terminal", data: { toolCallId: "call_1" } },
        ],
        { hasTerminalProviderStreamError: true },
      ),
    ).toBe(false);
  });

  it("does not retry empty assistant output", () => {
    expect(
      shouldRetryAgentLongWithFallback([], {
        hasTerminalProviderStreamError: true,
      }),
    ).toBe(false);
  });
});
