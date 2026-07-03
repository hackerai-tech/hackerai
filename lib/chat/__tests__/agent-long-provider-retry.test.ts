import {
  createAssistantContentLoopMonitor,
  detectAssistantContentLoopFromText,
  shouldRetryAgentLongWithFallback,
} from "../agent-long-provider-retry";

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

  it("retries repeated assistant content loops even when visible text exists", () => {
    const repeatedLoop = Array.from(
      { length: 5 },
      () =>
        "create the zip: [Tool: run_terminal_cmd] Files are there. Let me create the zip:",
    ).join(" ");

    expect(
      shouldRetryAgentLongWithFallback(
        [{ type: "step-start" }, { type: "text", text: repeatedLoop }],
        { hasTerminalProviderStreamError: false },
      ),
    ).toBe(true);
  });

  it("retries when the agent doom-loop stop fired even with tool output", () => {
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
        {
          hasTerminalProviderStreamError: false,
          stoppedDueToDoomLoop: true,
        },
      ),
    ).toBe(true);
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

describe("assistant content loop detection", () => {
  it("detects repeated text that arrives incrementally", () => {
    const monitor = createAssistantContentLoopMonitor();
    let detected = false;

    for (const delta of Array.from(
      { length: 6 },
      () => "Sorry. Single clean command now: ",
    )) {
      detected = monitor.appendDelta(delta).detected || detected;
    }

    expect(detected).toBe(true);
  });

  it("does not flag ordinary repeated task wording", () => {
    const detection = detectAssistantContentLoopFromText(
      [
        "I found the files and will create the archive.",
        "First I will verify the directory.",
        "Then I will run the zip command once.",
        "After that I will report the path.",
      ].join(" "),
    );

    expect(detection.detected).toBe(false);
  });
});
