import {
  createAssistantContentLoopMonitor,
  detectAssistantContentLoopFromText,
  shouldRetryAgentLongWithFallback,
  shouldRetryProviderStreamAfterInterruptedToolInput,
} from "../agent-long-provider-retry";

describe("shouldRetryAgentLongWithFallback", () => {
  it("allows an internal timeout fallback before meaningful output", () => {
    expect(
      shouldRetryAgentLongWithFallback([{ type: "step-start" }], {
        hasTerminalProviderStreamError: true,
      }),
    ).toBe(true);
  });

  it("does not replay after an internal timeout with meaningful partial output", () => {
    expect(
      shouldRetryAgentLongWithFallback(
        [
          { type: "step-start" },
          { type: "text", text: "I found the vulnerable endpoint." },
        ],
        { hasTerminalProviderStreamError: true },
      ),
    ).toBe(false);
  });

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

  it("retries terminal provider errors during meaningful tool input streaming", () => {
    const parts = [
      { type: "step-start" },
      { type: "text", text: "I'll update the file now." },
      {
        type: "tool-file",
        toolCallId: "call_1",
        state: "input-streaming",
        input: {
          action: "write",
          path: "/repo/script.py",
          text: "partial file body",
        },
      },
    ];

    expect(
      shouldRetryAgentLongWithFallback(parts, {
        hasTerminalProviderStreamError: true,
      }),
    ).toBe(true);
    expect(
      shouldRetryProviderStreamAfterInterruptedToolInput(parts, {
        hasTerminalProviderStreamError: true,
      }),
    ).toBe(true);
  });

  it("does not retry interrupted tool input without meaningful input", () => {
    expect(
      shouldRetryAgentLongWithFallback(
        [
          { type: "step-start" },
          {
            type: "tool-file",
            toolCallId: "call_1",
            state: "input-streaming",
            input: {},
          },
        ],
        { hasTerminalProviderStreamError: true },
      ),
    ).toBe(false);
  });

  it("does not replay an interrupted tool input after completed tool output", () => {
    const parts = [
      { type: "step-start" },
      {
        type: "tool-run_terminal_cmd",
        toolCallId: "call_1",
        state: "output-available",
        input: { command: "npm test" },
        output: { result: { exitCode: 0, output: "ok" } },
      },
      {
        type: "tool-file",
        toolCallId: "call_2",
        state: "input-streaming",
        input: {
          action: "write",
          path: "/repo/script.py",
          text: "partial file body",
        },
      },
    ];

    expect(
      shouldRetryAgentLongWithFallback(parts, {
        hasTerminalProviderStreamError: true,
      }),
    ).toBe(false);
    expect(
      shouldRetryProviderStreamAfterInterruptedToolInput(parts, {
        hasTerminalProviderStreamError: true,
      }),
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

  it("can disable fresh repeated-text detection for aborted streams", () => {
    const repeatedLoop = Array.from(
      { length: 5 },
      () => "Sorry. Single clean command now:",
    ).join(" ");

    expect(
      shouldRetryAgentLongWithFallback(
        [{ type: "step-start" }, { type: "text", text: repeatedLoop }],
        { hasTerminalProviderStreamError: false },
      ),
    ).toBe(true);

    expect(
      shouldRetryAgentLongWithFallback(
        [{ type: "step-start" }, { type: "text", text: repeatedLoop }],
        {
          hasTerminalProviderStreamError: false,
          detectAssistantContentLoop: false,
        },
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

  it("does not flag repeated structural code inside fenced blocks", () => {
    const xamlAnswer = [
      "Here is the fixed SettingsPanel.xaml:",
      "```xml",
      "<Grid.RowDefinitions>",
      '  <RowDefinition Height="Auto"/>',
      '  <RowDefinition Height="Auto"/>',
      '  <RowDefinition Height="Auto"/>',
      '  <RowDefinition Height="Auto"/>',
      '  <RowDefinition Height="Auto"/>',
      '  <RowDefinition Height="Auto"/>',
      "</Grid.RowDefinitions>",
      "```",
    ].join("\n");

    const detection = detectAssistantContentLoopFromText(xamlAnswer);

    expect(detection.detected).toBe(false);
    expect(
      shouldRetryAgentLongWithFallback(
        [{ type: "step-start" }, { type: "text", text: xamlAnswer }],
        { hasTerminalProviderStreamError: false },
      ),
    ).toBe(false);
  });

  it("does not flag repeated structural code in an open fenced block while streaming", () => {
    const monitor = createAssistantContentLoopMonitor();
    let detected = false;

    for (const delta of [
      "```xml\n<Grid.RowDefinitions>\n",
      '  <RowDefinition Height="Auto"/>\n',
      '  <RowDefinition Height="Auto"/>\n',
      '  <RowDefinition Height="Auto"/>\n',
      '  <RowDefinition Height="Auto"/>\n',
      '  <RowDefinition Height="Auto"/>\n',
      '  <RowDefinition Height="Auto"/>\n',
    ]) {
      detected = monitor.appendDelta(delta).detected || detected;
    }

    expect(detected).toBe(false);
  });
});
