import type { ModelMessage, UIMessage } from "ai";
import { MAX_CONTEXT_COMPACTION_ATTEMPTS_PER_AGENT_STREAM } from "@/lib/chat/summarization/constants";

const mockStreamText = jest.fn();
const mockRunSummarizationStep = jest.fn();
const mockCompactModelMessagesInRun = jest.fn();
const mockGetProviderPromptPressure = jest.fn();

jest.mock("server-only", () => ({}));
jest.mock("ai", () => ({
  convertToModelMessages: jest.fn(async (messages: UIMessage[]) =>
    messages.map((message) => ({
      role: message.role,
      content: message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    })),
  ),
  stepCountIs: jest.fn(() => () => false),
  streamText: mockStreamText,
}));
jest.mock("@/lib/api/chat-stream-helpers", () => ({
  addCacheBreakpointToLastUserMessage: (messages: ModelMessage[]) => messages,
  applyPrepareStepReminders: async (messages: ModelMessage[]) => messages,
  buildProviderOptions: () => ({}),
  buildSystemPrompt: (prompt: string) => prompt,
  getFallbackSlugs: () => [],
  isXaiSafetyError: () => false,
  runSummarizationStep: mockRunSummarizationStep,
}));
jest.mock("@/lib/chat/summarization", () => ({
  compactModelMessagesInRun: mockCompactModelMessagesInRun,
}));
jest.mock("@/lib/chat/summarization/provider-pressure", () => ({
  getProviderPromptPressure: mockGetProviderPromptPressure,
}));
jest.mock("@/lib/chat/doom-loop-detection", () => ({
  detectDoomLoop: () => ({
    severity: "none",
    toolNames: [],
    consecutiveCount: 0,
  }),
  generateDoomLoopNudge: () => "",
}));
jest.mock("@/lib/chat/agent-long-provider-retry", () => ({
  createAssistantContentLoopMonitor: () => ({
    appendDelta: () => ({ detected: false }),
  }),
}));
jest.mock("@/lib/chat/compaction/prune-tool-outputs", () => ({
  filterEmptyAssistantMessages: (messages: ModelMessage[]) => messages,
  repairAnthropicModelMessagesWithTelemetry: (messages: ModelMessage[]) => ({
    action: "none",
    messages,
  }),
  pruneToolOutputs: (messages: UIMessage[]) => ({
    messages,
    prunedCount: 0,
  }),
  pruneModelMessages: (messages: ModelMessage[]) => ({
    messages,
    prunedCount: 0,
  }),
}));
jest.mock("@/lib/chat/multimodal-tool-result-recovery", () => ({
  isProviderMultimodalToolResultRejectionError: () => false,
  toolResultsContainImageViewResult: () => false,
  uiMessagesContainImageViewResult: () => false,
}));
jest.mock("@/lib/ai/providers", () => ({
  isAnthropicModel: () => false,
}));
jest.mock("@/lib/ai/tools/utils/pty-session-manager", () => ({
  ptySessionManager: { closeAllSessions: jest.fn() },
}));
jest.mock("@/lib/ai/tools/prompt-serialization", () => ({
  createPromptSerializationTools: () => ({}),
}));
jest.mock("@/lib/api/openrouter-metadata", () => ({
  extractOpenRouterMetadata: () => ({}),
  mergeOpenRouterMetadata: () => ({}),
}));
jest.mock("@/lib/provider-usage-cost", () => ({
  getOpenRouterUpstreamInferenceCostFromUsageRaw: () => undefined,
}));
jest.mock("@/lib/utils/error-utils", () => ({
  classifyProviderOverflowError: () => null,
}));

const {
  createAgentStream,
  initAgentStreamState,
}: typeof import("@/lib/api/agent-stream-runner") = require("@/lib/api/agent-stream-runner");

const uiMessage = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

const createTestStreamContext = (
  overrides: Record<string, unknown>,
): Record<string, unknown> => ({
  trackedProvider: {
    languageModel: () => ({ modelId: "test-model" }),
  },
  currentSystemPrompt: "system",
  tools: {},
  mode: "agent",
  endpoint: "agent",
  userId: "user",
  subscription: "pro",
  chatId: "chat",
  temporary: false,
  fileTokens: {},
  noteInjectionOpts: {
    userId: "user",
    subscription: "pro",
    shouldIncludeNotes: false,
    isTemporary: false,
  },
  systemPromptTokens: 100,
  ctxSystemTokens: 100,
  ctxMaxTokens: 128_000,
  streamStartTime: Date.now(),
  contextUsageOn: true,
  isReasoningModel: false,
  maxDurationMs: 60_000,
  writer: { write: jest.fn() },
  abortController: new AbortController(),
  budgetMonitor: null,
  sandboxManager: {
    getSandboxType: () => undefined,
    supportsInteractivePty: async () => true,
  },
  getTodoManager: () => ({ getAllTodos: () => [] }),
  ensureSandbox: jest.fn(),
  chatLogger: undefined,
  usageRefundTracker: {},
  getHardTimeoutReason: () => null,
  ...overrides,
});

describe("createAgentStream repeated compaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStreamText.mockImplementation((options) => options);
  });

  it("rebases every later prepareStep onto the latest in-run summary", async () => {
    const summary1 = uiMessage("summary-1", "summary 1");
    const summary2 = uiMessage("summary-2", "summary 2");
    const ineffectiveSummary = uiMessage(
      "ineffective-summary",
      "ineffective ".repeat(4_000),
    );
    mockRunSummarizationStep.mockResolvedValue({
      summarizationAttempted: true,
      needsSummarization: true,
      summarizedMessages: [summary1],
    });
    mockCompactModelMessagesInRun
      .mockResolvedValueOnce({
        summaryMessage: ineffectiveSummary,
        summaryText: "ineffective",
        summarizationUsage: { inputTokens: 10, outputTokens: 2 },
      })
      .mockResolvedValue({
        summaryMessage: summary2,
        summaryText: "summary 2",
        summarizationUsage: { inputTokens: 10, outputTokens: 2 },
      });
    mockGetProviderPromptPressure
      .mockReturnValueOnce({ reason: "serialized_message_bytes", reasons: [] })
      .mockReturnValueOnce({ reason: "serialized_message_bytes", reasons: [] })
      .mockReturnValueOnce({ reason: "serialized_message_bytes", reasons: [] })
      .mockReturnValueOnce(null);

    const tracker = {
      hasSummarized: false,
      summarizationCount: 0,
      recordSummarization() {
        this.hasSummarized = true;
        this.summarizationCount++;
      },
      recordSummarizationUsage: jest.fn(),
    };
    const usageTracker = {
      inputTokens: 0,
      summarizationInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      summarizationOutputTokens: 0,
      cacheReadTokens: 0,
      summarizationCacheReadTokens: 0,
      cacheWriteTokens: 0,
      summarizationCacheWriteTokens: 0,
      providerCost: 0,
    };
    const original = uiMessage("original", "old ".repeat(2_000));
    const writer = { write: jest.fn() };
    const state = initAgentStreamState([original], {
      usedTokens: 120_000,
      maxTokens: 128_000,
    });
    const stream = (await createAgentStream(
      "test-model",
      createTestStreamContext({
        chatId: "chat",
        writer,
        summarizationTracker: tracker,
        usageTracker,
      }) as any,
      state,
    )) as any;

    const initialRaw: ModelMessage[] = [
      { role: "user", content: "old ".repeat(2_000) },
    ];
    const first = await stream.prepareStep({
      steps: [],
      messages: initialRaw,
    });
    expect(first.messages[0].content).toBe("summary 1");
    state.lastStepInputTokens = 300_000;
    expect(stream.stopWhen[1]()).toBe(false);

    const step1: ModelMessage = {
      role: "assistant",
      content: "tool step 1 ".repeat(1_000),
    };
    const second = await stream.prepareStep({
      steps: [{ toolResults: [], response: { messages: [step1] } }],
      messages: [...initialRaw, step1],
    });
    expect(mockCompactModelMessagesInRun).toHaveBeenCalledWith(
      expect.objectContaining({
        modelMessages: expect.arrayContaining([
          expect.objectContaining({ content: "summary 1" }),
          step1,
        ]),
        transcriptModelMessages: [...initialRaw, step1],
        compactionIndex: 2,
      }),
    );
    expect(second.messages[0].content).toBe("summary 1");
    expect(writer.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "data-summarization",
        id: "summarization-status-2",
        data: { status: "completed", message: "" },
        transient: true,
      }),
    );
    expect(tracker.summarizationCount).toBe(1);
    expect(tracker.recordSummarizationUsage).toHaveBeenCalledTimes(1);

    const step2: ModelMessage = {
      role: "assistant",
      content: "tool step 2 ".repeat(1_000),
    };
    const third = await stream.prepareStep({
      steps: [
        { toolResults: [], response: { messages: [step1] } },
        { toolResults: [], response: { messages: [step2] } },
      ],
      messages: [...initialRaw, step1, step2],
    });
    expect(third.messages[0].content).toBe("summary 2");
    expect(tracker.summarizationCount).toBe(2);

    state.lastStepInputTokens = 0;
    const step3: ModelMessage = { role: "assistant", content: "tool step 3" };
    const fourth = await stream.prepareStep({
      steps: [
        { toolResults: [], response: { messages: [step1] } },
        { toolResults: [], response: { messages: [step2] } },
        { toolResults: [], response: { messages: [step3] } },
      ],
      messages: [...initialRaw, step1, step2, step3],
    });
    expect(fourth.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "summary 2" }),
        step3,
      ]),
    );
    expect(fourth.messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: initialRaw[0].content }),
      ]),
    );
    expect(mockCompactModelMessagesInRun).toHaveBeenCalledTimes(2);

    mockGetProviderPromptPressure.mockReturnValue({
      reason: "serialized_message_bytes",
      reasons: [],
    });
    const accumulatedRaw = [...initialRaw, step1, step2, step3];
    const accumulatedSteps = [
      { toolResults: [], response: { messages: [step1] } },
      { toolResults: [], response: { messages: [step2] } },
      { toolResults: [], response: { messages: [step3] } },
    ];
    for (
      let index = 4;
      index <= MAX_CONTEXT_COMPACTION_ATTEMPTS_PER_AGENT_STREAM;
      index++
    ) {
      const nextStep: ModelMessage = {
        role: "assistant",
        content: `large tool step ${index} `.repeat(1_000),
      };
      accumulatedRaw.push(nextStep);
      accumulatedSteps.push({
        toolResults: [],
        response: { messages: [nextStep] },
      });
      await stream.prepareStep({
        steps: accumulatedSteps,
        messages: accumulatedRaw,
      });
    }

    expect(tracker.summarizationCount).toBe(
      MAX_CONTEXT_COMPACTION_ATTEMPTS_PER_AGENT_STREAM - 1,
    );
    expect(mockCompactModelMessagesInRun).toHaveBeenCalledTimes(
      MAX_CONTEXT_COMPACTION_ATTEMPTS_PER_AGENT_STREAM - 1,
    );
    state.lastStepInputTokens = 300_000;
    expect(stream.stopWhen[1]()).toBe(true);
    expect(state.stoppedDueToTokenExhaustion).toBe(true);
  });

  it("retains the latest completed tool pair across rolling compaction", async () => {
    const summary = uiMessage(
      "summary-tool-pair",
      "Continue the remaining rounds.",
    );
    mockCompactModelMessagesInRun.mockResolvedValue({
      summaryMessage: summary,
      summaryText: "Continue the remaining rounds.",
      summarizationUsage: { inputTokens: 10, outputTokens: 2 },
    });
    mockGetProviderPromptPressure
      .mockReturnValueOnce({
        reason: "serialized_message_bytes",
        reasons: [],
      })
      .mockReturnValue(null);

    const tracker = {
      hasSummarized: true,
      summarizationCount: 1,
      recordSummarization() {
        this.summarizationCount++;
      },
      recordSummarizationUsage: jest.fn(),
    };
    const largeOldUserContent = "old context ".repeat(4_000);
    const initialRaw: ModelMessage[] = [
      { role: "user", content: largeOldUserContent },
    ];
    const toolCall = {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "round-1",
          toolName: "run_terminal_cmd",
          input: { command: "printf 'ROUND_1_BEGIN\\nROUND_1_END\\n'" },
        },
      ],
    } as ModelMessage;
    const toolResult = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "round-1",
          toolName: "run_terminal_cmd",
          output: {
            type: "text",
            value: "ROUND_1_BEGIN\nROUND_1_END",
          },
        },
      ],
    } as ModelMessage;
    const state = initAgentStreamState(
      [uiMessage("original-tool-pair", largeOldUserContent)],
      { usedTokens: 120_000, maxTokens: 128_000 },
    );
    state.lastStepInputTokens = 300_000;
    const stream = (await createAgentStream(
      "test-model",
      createTestStreamContext({
        chatId: "chat-tool-pair",
        summarizationTracker: tracker,
        usageTracker: {},
      }) as any,
      state,
    )) as any;

    const countToolParts = (
      messages: ModelMessage[],
      type: "tool-call" | "tool-result",
    ) =>
      messages.reduce((count, message) => {
        if (!Array.isArray(message.content)) return count;
        return (
          count +
          message.content.filter((part) => {
            const record = part as Record<string, unknown>;
            return record.type === type && record.toolCallId === "round-1";
          }).length
        );
      }, 0);
    const findToolPartMessageIndex = (
      messages: ModelMessage[],
      type: "tool-call" | "tool-result",
    ) =>
      messages.findIndex(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some((part) => {
            const record = part as Record<string, unknown>;
            return record.type === type && record.toolCallId === "round-1";
          }),
      );

    const compacted = await stream.prepareStep({
      steps: [
        {
          toolResults: [],
          response: { messages: [toolCall, toolResult] },
        },
      ],
      messages: [...initialRaw, toolCall, toolResult],
    });

    expect(countToolParts(compacted.messages, "tool-call")).toBe(1);
    expect(countToolParts(compacted.messages, "tool-result")).toBe(1);
    expect(findToolPartMessageIndex(compacted.messages, "tool-result")).toBe(
      findToolPartMessageIndex(compacted.messages, "tool-call") + 1,
    );
    expect(JSON.stringify(compacted.messages)).toContain("ROUND_1_END");
    expect(compacted.messages.at(-1)?.role).toBe("user");

    state.lastStepInputTokens = 0;
    const newerAssistantMessage: ModelMessage = {
      role: "assistant",
      content: "Round 1 is complete; continue with Round 2.",
    };
    const rebased = await stream.prepareStep({
      steps: [
        {
          toolResults: [],
          response: { messages: [toolCall, toolResult] },
        },
        {
          toolResults: [],
          response: { messages: [newerAssistantMessage] },
        },
      ],
      messages: [...initialRaw, toolCall, toolResult, newerAssistantMessage],
    });

    expect(countToolParts(rebased.messages, "tool-call")).toBe(1);
    expect(countToolParts(rebased.messages, "tool-result")).toBe(1);
    expect(rebased.messages).toContainEqual(newerAssistantMessage);
    expect(JSON.stringify(rebased.messages)).not.toContain(largeOldUserContent);
    expect(mockCompactModelMessagesInRun).toHaveBeenCalledTimes(1);
  });

  it("stops cleanly when the attempt budget is exhausted with no accepted summary", async () => {
    mockRunSummarizationStep.mockResolvedValue({
      summarizationAttempted: true,
      needsSummarization: false,
    });
    mockCompactModelMessagesInRun.mockResolvedValue(null);
    mockGetProviderPromptPressure.mockReturnValue({
      reason: "serialized_message_bytes",
      reasons: [],
    });
    const tracker = {
      hasSummarized: false,
      summarizationCount: 0,
      recordSummarization: jest.fn(),
      recordSummarizationUsage: jest.fn(),
    };
    const initialRaw: ModelMessage[] = [
      { role: "user", content: "oversized initial history" },
    ];
    const state = initAgentStreamState(
      [uiMessage("original-failure", "oversized initial history")],
      { usedTokens: 200_000, maxTokens: 200_000 },
    );
    const stream = (await createAgentStream(
      "test-model",
      createTestStreamContext({
        chatId: "chat-failure",
        ctxMaxTokens: 200_000,
        summarizationTracker: tracker,
        usageTracker: {},
      }) as any,
      state,
    )) as any;

    await stream.prepareStep({ steps: [], messages: initialRaw });
    const rawMessages = [...initialRaw];
    const steps: Array<Record<string, unknown>> = [];
    for (
      let index = 1;
      index <= MAX_CONTEXT_COMPACTION_ATTEMPTS_PER_AGENT_STREAM;
      index++
    ) {
      const step: ModelMessage = {
        role: "assistant",
        content: `failed compaction step ${index}`,
      };
      rawMessages.push(step);
      steps.push({ toolResults: [], response: { messages: [step] } });
      await stream.prepareStep({ steps, messages: rawMessages });
    }

    expect(mockCompactModelMessagesInRun).toHaveBeenCalledTimes(
      MAX_CONTEXT_COMPACTION_ATTEMPTS_PER_AGENT_STREAM - 1,
    );
    expect(tracker.summarizationCount).toBe(0);
    expect(tracker.recordSummarization).not.toHaveBeenCalled();
    state.lastStepInputTokens = 300_000;
    expect(stream.stopWhen[1]()).toBe(true);
    expect(state.stoppedDueToTokenExhaustion).toBe(true);
  });
});
