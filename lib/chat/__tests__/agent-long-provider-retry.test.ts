import {
  createAssistantContentLoopMonitor,
  detectAssistantContentLoopFromText,
  getNextDeepSeekProDisconnectRetryModel,
  prepareProviderDisconnectContinuation,
  shouldRetryAgentLongWithFallback,
  shouldRetryProviderStreamAfterNonDurableOutputLimit,
  shouldRetryProviderStreamAfterReasoningOnlyOutput,
  shouldRetryProviderStreamAfterInterruptedToolInput,
} from "../agent-long-provider-retry";
import type { UIMessage } from "ai";

describe("prepareProviderDisconnectContinuation", () => {
  it("preserves completed text and tool output while removing only the failed step", () => {
    const messages = [
      { id: "user-1", role: "user", parts: [{ type: "text", text: "fix it" }] },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "text", text: "I found the issue.", state: "done" },
          {
            type: "tool-run_terminal_cmd",
            toolCallId: "call-1",
            state: "output-available",
            input: { command: "npm test" },
            output: { result: { exitCode: 0, output: "ok" } },
          },
          { type: "step-start" },
          { type: "text", text: "The final answer was cut", state: "done" },
        ],
      },
    ] as UIMessage[];

    const recovery = prepareProviderDisconnectContinuation(messages);

    expect(recovery).toMatchObject({
      removedPartCount: 2,
      preservedCompletedToolCount: 1,
      preservedTextPartCount: 1,
    });
    expect(recovery?.messages.at(-1)?.parts).toEqual([
      { type: "step-start" },
      { type: "text", text: "I found the issue.", state: "done" },
      {
        type: "tool-run_terminal_cmd",
        toolCallId: "call-1",
        state: "output-available",
        input: { command: "npm test" },
        output: { result: { exitCode: 0, output: "ok" } },
      },
    ]);
  });

  it("keeps a completed tool result in the failed step and drops its partial tail", () => {
    const messages = [
      { id: "user-1", role: "user", parts: [{ type: "text", text: "fix it" }] },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-file",
            toolCallId: "call-1",
            state: "output-available",
            input: { action: "write", path: "/repo/a.ts" },
            output: { ok: true },
          },
          { type: "text", text: "Now I will", state: "streaming" },
        ],
      },
    ] as UIMessage[];

    const recovery = prepareProviderDisconnectContinuation(messages);

    expect(recovery?.removedPartCount).toBe(1);
    expect(recovery?.preservedCompletedToolCount).toBe(1);
    expect(recovery?.messages.at(-1)?.parts).toHaveLength(2);
  });

  it("removes an entirely incomplete first assistant step", () => {
    const messages = [
      { id: "user-1", role: "user", parts: [{ type: "text", text: "answer" }] },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "text", text: "partial", state: "done" },
        ],
      },
    ] as UIMessage[];

    const recovery = prepareProviderDisconnectContinuation(messages);

    expect(recovery?.removedPartCount).toBe(2);
    expect(recovery?.messages).toEqual([messages[0]]);
  });
});

describe("getNextDeepSeekProDisconnectRetryModel", () => {
  it("uses GLM 5.3 and then one final Kimi retry", () => {
    expect(
      getNextDeepSeekProDisconnectRetryModel({
        originalModel: "model-deepseek-v4-pro-0813",
        failedModel: "model-deepseek-v4-pro-0813",
        completedRetryCount: 0,
      }),
    ).toBe("model-glm-5.3");

    expect(
      getNextDeepSeekProDisconnectRetryModel({
        originalModel: "model-deepseek-v4-pro-0813",
        failedModel: "model-glm-5.3",
        completedRetryCount: 1,
      }),
    ).toBe("model-kimi-k3");
  });

  it("stops after Kimi and does not affect other original models", () => {
    expect(
      getNextDeepSeekProDisconnectRetryModel({
        originalModel: "model-deepseek-v4-pro-0813",
        failedModel: "model-grok-4.6",
        completedRetryCount: 1,
      }),
    ).toBeUndefined();
    expect(
      getNextDeepSeekProDisconnectRetryModel({
        originalModel: "model-deepseek-v4-pro-0813",
        failedModel: "model-kimi-k3",
        completedRetryCount: 2,
      }),
    ).toBeUndefined();
    expect(
      getNextDeepSeekProDisconnectRetryModel({
        originalModel: "model-grok-4.6",
        failedModel: "model-grok-4.6",
        completedRetryCount: 0,
      }),
    ).toBeUndefined();
  });
});

describe("shouldRetryAgentLongWithFallback", () => {
  it.each([
    { label: "empty output", parts: [] },
    { label: "only a step boundary", parts: [{ type: "step-start" }] },
    {
      label: "only blank text",
      parts: [{ type: "text", text: "  \n\t" }],
    },
    {
      label: "hidden reasoning and metadata",
      parts: [
        { type: "data-agent-heartbeat", data: { at: 1 } },
        { type: "step-start" },
        { type: "reasoning", text: "thinking", state: "done" },
        { type: "data-context-usage", data: { usedTokens: 100 } },
      ],
    },
  ])("retries an output limit with $label", ({ parts }) => {
    expect(
      shouldRetryAgentLongWithFallback(parts, {
        hasTerminalProviderStreamError: false,
        finishReason: "length",
      }),
    ).toBe(true);
  });

  it.each([
    {
      label: "visible text",
      parts: [{ type: "text", text: "partial answer" }],
    },
    {
      label: "a completed tool call",
      parts: [
        {
          type: "tool-run_terminal_cmd",
          state: "output-available",
          output: { result: { exitCode: 0 } },
        },
      ],
    },
  ])("preserves $label at the output limit", ({ parts }) => {
    expect(
      shouldRetryProviderStreamAfterNonDurableOutputLimit(parts, {
        finishReason: "length",
      }),
    ).toBe(false);
    expect(
      shouldRetryAgentLongWithFallback(parts, {
        hasTerminalProviderStreamError: false,
        finishReason: "length",
      }),
    ).toBe(false);
  });

  it("does not retry empty output after a normal stop", () => {
    expect(
      shouldRetryProviderStreamAfterNonDurableOutputLimit([], {
        finishReason: "stop",
      }),
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

  it.each([
    {
      label: "no output",
      parts: [{ type: "step-start" }],
    },
    {
      label: "partial text",
      parts: [{ type: "step-start" }, { type: "text", text: "partial answer" }],
    },
    {
      label: "completed tool call",
      parts: [
        { type: "step-start" },
        {
          type: "tool-run_terminal_cmd",
          toolCallId: "call-1",
          state: "output-available",
          output: { result: { exitCode: 0 } },
        },
      ],
    },
  ])("retries provider content blocks with $label", ({ parts }) => {
    expect(
      shouldRetryAgentLongWithFallback(parts, {
        hasTerminalProviderStreamError: true,
        providerContentBlocked: true,
      }),
    ).toBe(true);
  });

  it("does not treat a user abort as a provider retry", () => {
    expect(
      shouldRetryAgentLongWithFallback(
        [
          { type: "step-start" },
          { type: "reasoning", text: "thinking", state: "streaming" },
        ],
        {
          hasTerminalProviderStreamError: false,
          detectAssistantContentLoop: false,
        },
      ),
    ).toBe(false);
  });
});

describe("shouldRetryProviderStreamAfterReasoningOnlyOutput", () => {
  it("accepts terminal reasoning-only output with hidden metadata", () => {
    expect(
      shouldRetryProviderStreamAfterReasoningOnlyOutput(
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

  it.each([
    {
      label: "a completed tool side effect",
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "thinking", state: "done" },
        {
          type: "tool-run_terminal_cmd",
          toolCallId: "call_1",
          state: "output-available",
          output: { result: { exitCode: 0 } },
        },
      ],
    },
    {
      label: "visible text",
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "thinking", state: "done" },
        { type: "text", text: "partial answer" },
      ],
    },
    {
      label: "interrupted tool input",
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "thinking", state: "done" },
        {
          type: "tool-file",
          toolCallId: "call_1",
          state: "input-streaming",
          input: { path: "/repo/file.ts" },
        },
      ],
    },
  ])("rejects terminal output containing $label", ({ parts }) => {
    expect(
      shouldRetryProviderStreamAfterReasoningOnlyOutput(parts, {
        hasTerminalProviderStreamError: true,
      }),
    ).toBe(false);
  });

  it("rejects reasoning-only output without a terminal provider error", () => {
    expect(
      shouldRetryProviderStreamAfterReasoningOnlyOutput(
        [
          { type: "step-start" },
          { type: "reasoning", text: "thinking", state: "done" },
        ],
        { hasTerminalProviderStreamError: false },
      ),
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
