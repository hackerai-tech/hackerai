import type { ModelMessage, UIMessage } from "ai";
import { MAX_CONTEXT_COMPACTION_ATTEMPTS_PER_AGENT_STREAM } from "@/lib/chat/summarization/constants";
import { PLATFORM_AUTHORIZATION_ANNOTATION } from "@/lib/chat/platform-authorization";

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
  wrapLanguageModel: jest.fn(({ model }) => model),
}));
jest.mock("@/lib/api/chat-stream-helpers", () => ({
  addCacheBreakpointToLastUserMessage: (messages: ModelMessage[]) => messages,
  applyPrepareStepReminders: async (messages: ModelMessage[]) => messages,
  buildProviderOptions: () => ({}),
  buildSystemPrompt: (prompt: string) => prompt,
  getFallbackSlugs: () => [],
  isXaiSafetyError: () => false,
  resolveServedModelForCostAccounting: ({
    modelName,
    responseModel,
  }: {
    modelName: string;
    responseModel?: string;
  }) => responseModel ?? modelName,
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
  limitModelImageToolResults: (messages: ModelMessage[]) => ({
    messages,
    totalImageCount: 0,
    elidedImageCount: 0,
  }),
}));
jest.mock("@/lib/chat/multimodal-tool-result-recovery", () => ({
  isProviderMultimodalToolResultRejectionError: () => false,
  toolResultsContainImageViewResult: () => false,
  uiMessagesContainImageViewResult: () => false,
}));
jest.mock("@/lib/ai/providers", () => ({
  isAnthropicModel: () => false,
  isDeepSeekModel: (modelName: string) =>
    modelName.startsWith("model-deepseek-v4"),
  PDF_PARSER_ENGINE_HEADER: "x-hackerai-openrouter-pdf-parser-engine",
  PDF_PARSER_RECOVERY_HEADER: "x-hackerai-openrouter-pdf-parser-recovery",
}));
jest.mock("@/lib/ai/tools/utils/pty-session-manager", () => ({
  ptySessionManager: { closeAllSessions: jest.fn() },
}));
jest.mock("@/lib/ai/tools/prompt-serialization", () => ({
  createPromptSerializationTools: () => ({}),
}));
jest.mock("@/lib/api/openrouter-metadata", () => ({
  extractOpenRouterMetadata: () => ({}),
  extractOpenRouterMetadataFromError: () => ({}),
  fetchOpenRouterGenerationMetadata: async () => ({}),
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
  omitPdfFilePartsFromModelMessages,
  resetServedModelTelemetryForRetry,
  resolveAgentModelAfterSummarization,
  resolveAgentModelForImageToolResults,
  resolveFallbackServedTelemetry,
  retryUsesDifferentModel,
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
  fileTokens: {},
  noteInjectionOpts: {
    userId: "user",
    subscription: "pro",
    shouldIncludeNotes: false,
  },
  systemPromptTokens: 100,
  ctxSystemTokens: 100,
  ctxMaxTokens: 128_000,
  streamStartTime: Date.now(),
  contextUsageOn: true,
  isReasoningModel: false,
  platformAuthorized: false,
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

describe("resolveAgentModelForImageToolResults", () => {
  it("keeps DeepSeek for text-only Agent steps", () => {
    expect(
      resolveAgentModelForImageToolResults(
        "model-deepseek-v4-pro",
        "agent",
        false,
      ),
    ).toBe("model-deepseek-v4-pro");
  });

  it("infers the Grok 4.5 high route for Pro image tool results", () => {
    expect(
      resolveAgentModelForImageToolResults(
        "model-deepseek-v4-pro",
        "agent",
        true,
      ),
    ).toBe("model-grok-4.5-pro");
  });

  it("uses Grok 4.5 medium for Standard image tool results", () => {
    expect(
      resolveAgentModelForImageToolResults(
        "model-deepseek-v4-flash-0731",
        "agent",
        true,
        "hackerai-standard",
      ),
    ).toBe("model-grok-4.5");
  });

  it("uses Grok 4.5 high for Pro image tool results", () => {
    expect(
      resolveAgentModelForImageToolResults(
        "model-deepseek-v4-pro-0813",
        "agent",
        true,
        "hackerai-pro",
      ),
    ).toBe("model-grok-4.5-pro");
  });

  it("uses direct GLM Flash for Standard image tool results", () => {
    expect(
      resolveAgentModelForImageToolResults(
        "model-deepseek-v4-flash-0731",
        "agent",
        true,
        "hackerai-standard",
        false,
        true,
      ),
    ).toBe("model-glm-5.3-flash");
  });

  it("uses direct GLM Flash Pro for Pro image tool results", () => {
    expect(
      resolveAgentModelForImageToolResults(
        "model-deepseek-v4-pro-0813",
        "agent",
        true,
        "hackerai-pro",
        false,
        true,
      ),
    ).toBe("model-glm-5.3-flash-pro");
  });

  it("keeps the DeepSeek text model during MiniMax summary recovery", () => {
    expect(
      resolveAgentModelForImageToolResults(
        "model-deepseek-v4-pro-0813",
        "agent",
        true,
        "hackerai-pro",
        true,
        true,
      ),
    ).toBe("model-deepseek-v4-pro-0813");
  });

  it.each(["model-deepseek-v4-flash-0731", "model-deepseek-v4-pro-0813"])(
    "keeps %s active when image tool results have auxiliary descriptions",
    (modelName) => {
      expect(
        resolveAgentModelForImageToolResults(
          modelName,
          "agent",
          true,
          modelName.includes("pro") ? "hackerai-pro" : "hackerai-standard",
          true,
        ),
      ).toBe(modelName);
    },
  );

  it("keeps Auto on Grok 4.5 medium after a text retry reached DeepSeek Pro", () => {
    expect(
      resolveAgentModelForImageToolResults(
        "model-deepseek-v4-pro-0813",
        "agent",
        true,
        "auto",
      ),
    ).toBe("model-grok-4.5");
  });

  it("keeps the HackerAI Pro GLM 5.3 fallback active after image tool results", () => {
    expect(
      resolveAgentModelForImageToolResults("model-glm-5.3", "agent", true),
    ).toBe("model-glm-5.3");
  });

  it("keeps the multimodal free GLM Agent active after image tool results", () => {
    expect(
      resolveAgentModelForImageToolResults("agent-model-free", "agent", true),
    ).toBe("agent-model-free");
  });

  it("does not change Ask routes or multimodal Agent models", () => {
    expect(
      resolveAgentModelForImageToolResults(
        "model-deepseek-v4-pro",
        "ask",
        true,
      ),
    ).toBe("model-deepseek-v4-pro");
    expect(
      resolveAgentModelForImageToolResults("model-kimi-k3", "agent", true),
    ).toBe("model-kimi-k3");
    expect(
      resolveAgentModelForImageToolResults("model-grok-4.6-pro", "agent", true),
    ).toBe("model-grok-4.6-pro");
  });
});

describe("resolveAgentModelAfterSummarization", () => {
  it("returns Standard and Pro vision routes to their DeepSeek text routes", () => {
    expect(
      resolveAgentModelAfterSummarization("model-grok-4.5", "agent", false),
    ).toBe("model-deepseek-v4-flash-0731");
    expect(
      resolveAgentModelAfterSummarization("model-grok-4.5-pro", "agent", false),
    ).toBe("model-deepseek-v4-pro-0813");
    expect(
      resolveAgentModelAfterSummarization(
        "model-glm-5.3-flash",
        "agent",
        false,
      ),
    ).toBe("model-deepseek-v4-flash-0731");
    expect(
      resolveAgentModelAfterSummarization(
        "model-glm-5.3-flash-pro",
        "agent",
        false,
      ),
    ).toBe("model-deepseek-v4-pro-0813");
  });

  it("keeps vision routes when compacted context still contains images", () => {
    expect(
      resolveAgentModelAfterSummarization("model-grok-4.5", "agent", true),
    ).toBe("model-grok-4.5");
    expect(
      resolveAgentModelAfterSummarization("model-grok-4.5-pro", "agent", true),
    ).toBe("model-grok-4.5-pro");
  });

  it("does not rewrite Ask or native non-vision-promotion routes", () => {
    expect(
      resolveAgentModelAfterSummarization("model-grok-4.5", "ask", false),
    ).toBe("model-grok-4.5");
    expect(
      resolveAgentModelAfterSummarization("model-grok-4.6", "agent", false),
    ).toBe("model-grok-4.6");
  });
});

describe("omitPdfFilePartsFromModelMessages", () => {
  it("removes provider PDF parts while preserving the sandbox attachment tag", () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: '<attachment filename="report.pdf" local_path="/home/user/upload/report.pdf" />',
          },
          {
            type: "file" as const,
            data: "data:application/pdf;base64,JVBERi0=",
            mediaType: "application/pdf",
          },
        ],
      },
    ] satisfies ModelMessage[];

    const result = omitPdfFilePartsFromModelMessages(messages);

    expect(result).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: '<attachment filename="report.pdf" local_path="/home/user/upload/report.pdf" />',
          },
        ],
      },
    ]);
  });

  it("drops a user message when removing its PDF leaves empty content", () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          {
            type: "file" as const,
            data: "data:application/pdf;base64,JVBERi0=",
            mediaType: "application/pdf",
          },
        ],
      },
    ] satisfies ModelMessage[];

    expect(omitPdfFilePartsFromModelMessages(messages)).toEqual([]);
  });
});

describe("resolveFallbackServedTelemetry", () => {
  it("returns false for the requested primary model", () => {
    expect(
      resolveFallbackServedTelemetry({
        requestedModel: "deepseek/deepseek-v4-pro",
        responseModel: "deepseek/deepseek-v4-pro",
        fallbackModels: ["x-ai/grok-4.6"],
      }),
    ).toBe(false);
  });

  it("returns true only for a configured fallback model", () => {
    expect(
      resolveFallbackServedTelemetry({
        requestedModel: "deepseek/deepseek-v4-pro",
        responseModel: "x-ai/grok-4.6",
        fallbackModels: ["x-ai/grok-4.6"],
      }),
    ).toBe(true);
    expect(
      resolveFallbackServedTelemetry({
        requestedModel: "x-ai/grok-4.6",
        responseModel: "x-ai/grok-4.6",
        fallbackModels: ["x-ai/grok-4.6"],
      }),
    ).toBe(false);
  });

  it("returns undefined without a response model or an exact route match", () => {
    expect(
      resolveFallbackServedTelemetry({
        requestedModel: "anthropic/claude-opus-4.6",
        fallbackModels: ["x-ai/grok-4.6"],
      }),
    ).toBeUndefined();
    expect(
      resolveFallbackServedTelemetry({
        requestedModel: "anthropic/claude-opus-4.6",
        responseModel: "anthropic/claude-4.6-opus-20260205",
        fallbackModels: ["x-ai/grok-4.6"],
      }),
    ).toBeUndefined();
  });
});

describe("retry served-model telemetry", () => {
  it("does not label a same-model image recovery as a fallback model retry", () => {
    expect(
      retryUsesDifferentModel("agent-model-free", "agent-model-free"),
    ).toBe(false);
    expect(retryUsesDifferentModel("agent-model-free", "model-grok-4.6")).toBe(
      true,
    );
  });

  it("clears prior served-model state before a retry can abort without metadata", () => {
    const state = {
      responseModel: "deepseek/deepseek-v4-flash-0731",
      fallbackServed: false,
    };

    resetServedModelTelemetryForRetry(state);

    expect(state).toEqual({
      responseModel: undefined,
      fallbackServed: undefined,
    });
  });
});

describe("createAgentStream repeated compaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStreamText.mockImplementation((options) => options);
  });

  afterEach(() => {
    mockRunSummarizationStep.mockReset();
    mockCompactModelMessagesInRun.mockReset();
    mockGetProviderPromptPressure.mockReset();
  });

  it("reports the first provider chunk to startup timing", async () => {
    const onModelChunk = jest.fn();
    const stream = (await createAgentStream(
      "test-model",
      createTestStreamContext({
        onModelChunk,
        summarizationTracker: {
          hasSummarized: false,
          summarizationCount: 0,
        },
        usageTracker: {},
      }) as any,
      initAgentStreamState([uiMessage("initial", "Say hello")], {
        usedTokens: 1_000,
        maxTokens: 128_000,
      }),
    )) as any;

    await stream.onChunk({
      chunk: { type: "text-delta", id: "text-1", text: "Hello" },
    });

    expect(onModelChunk).toHaveBeenCalledTimes(1);
  });

  it("includes sandbox and Trigger runtime in budget checks and per-step settlement", async () => {
    const checkAfterStep = jest.fn(() => undefined);
    const settleUsageAfterStep = jest.fn(async () => undefined);
    const usageTracker = {
      accumulateStep: jest.fn(() => 0),
      setAuthoritativeModelCostForStep: jest.fn(),
      computeCostDollars: jest.fn(() => 0.2),
    };
    const state = initAgentStreamState([uiMessage("initial", "Run a scan")], {
      usedTokens: 1_000,
      maxTokens: 128_000,
    });
    const stream = (await createAgentStream(
      "test-model",
      createTestStreamContext({
        budgetMonitor: { checkAfterStep },
        getSandboxCostDollars: () => 0.05,
        getTriggerRunCostDollars: () => 0.03,
        settleUsageAfterStep,
        summarizationTracker: {
          hasSummarized: false,
          summarizationCount: 0,
          recordSummarization: jest.fn(),
        },
        usageTracker,
      }) as any,
      state,
    )) as any;

    await stream.onStepFinish({
      usage: { inputTokens: 10, outputTokens: 5 },
      response: { modelId: "test-model" },
      providerMetadata: undefined,
    });

    expect(checkAfterStep).toHaveBeenCalledWith(0.28);
    expect(settleUsageAfterStep).toHaveBeenCalledWith({
      currentCostDollars: 0.28,
      sandboxCostDollars: 0.05,
      triggerRunCostDollars: 0.03,
      force: false,
      model: "test-model",
    });
  });

  it("forces durable waiting, injects the claimed result, and consumes it after synthesis", async () => {
    let completionState = {
      activeCount: 1,
      unconsumedSubagentIds: [] as string[],
    };
    const markInjected = jest.fn(async () => undefined);
    const markConsumed = jest.fn(async () => {
      completionState = { activeCount: 0, unconsumedSubagentIds: [] };
    });
    const onBlocked = jest.fn();
    const usageTracker = {
      setAuthoritativeModelCostForStep: jest.fn(),
      computeCostDollars: jest.fn(() => 0),
    };
    const state = initAgentStreamState([uiMessage("initial", "Delegate")], {
      usedTokens: 1_000,
      maxTokens: 128_000,
    });
    const stream = (await createAgentStream(
      "test-model",
      createTestStreamContext({
        tools: { wait_for_agents: {} },
        summarizationTracker: {
          hasSummarized: false,
          summarizationCount: 0,
        },
        usageTracker,
        subagentCompletionGate: {
          getState: async () => completionState,
          markInjected,
          markConsumed,
          onBlocked,
        },
      }) as any,
      state,
    )) as any;

    const forcedWait = await stream.prepareStep({
      steps: [{ toolResults: [{ toolName: "create_agent", output: {} }] }],
      messages: [{ role: "user", content: "Delegate" }],
    });
    expect(forcedWait.toolChoice).toEqual({
      type: "tool",
      toolName: "wait_for_agents",
    });
    expect(forcedWait.messages.at(-1)?.content).toContain(
      "cannot finish this response",
    );
    expect(onBlocked).toHaveBeenCalledWith(completionState);

    completionState = {
      activeCount: 0,
      unconsumedSubagentIds: ["sa_1"],
    };
    const deliveryClaim = { subagent_id: "sa_1", claim_id: "claim_1" };
    const synthesis = await stream.prepareStep({
      steps: [
        {
          toolResults: [
            {
              toolName: "wait_for_agents",
              output: { _delivery_claim: deliveryClaim },
            },
          ],
        },
      ],
      messages: [{ role: "user", content: "Delegate" }],
    });
    expect(markInjected).toHaveBeenCalledWith([deliveryClaim]);
    expect(synthesis.toolChoice).toBeUndefined();

    await stream.onStepFinish({
      usage: undefined,
      response: { modelId: "test-model" },
      providerMetadata: undefined,
    });
    expect(markConsumed).toHaveBeenCalledWith([deliveryClaim]);
    expect(completionState).toEqual({
      activeCount: 0,
      unconsumedSubagentIds: [],
    });
  });

  it("fails closed when injection or gate-state persistence is unavailable", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const usageTracker = {
      setAuthoritativeModelCostForStep: jest.fn(),
      computeCostDollars: jest.fn(() => 0),
    };
    const summarizationTracker = {
      hasSummarized: false,
      summarizationCount: 0,
    };
    const deliveryClaim = { subagent_id: "sa_1", claim_id: "claim_1" };
    const injectionFailureStream = (await createAgentStream(
      "test-model",
      createTestStreamContext({
        tools: { wait_for_agents: {} },
        usageTracker,
        summarizationTracker,
        subagentCompletionGate: {
          getState: jest.fn(async () => ({
            activeCount: 0,
            unconsumedSubagentIds: ["sa_1"],
          })),
          markInjected: jest.fn(async () => {
            throw new Error("persistence unavailable");
          }),
          markConsumed: jest.fn(async () => undefined),
        },
      }) as any,
      initAgentStreamState([uiMessage("initial", "Delegate")], {
        usedTokens: 1_000,
        maxTokens: 128_000,
      }),
    )) as any;

    const injectionFailure = await injectionFailureStream.prepareStep({
      steps: [
        {
          toolResults: [
            {
              toolName: "wait_for_agents",
              output: { _delivery_claim: deliveryClaim },
            },
          ],
        },
      ],
      messages: [{ role: "user", content: "Delegate" }],
    });
    expect(injectionFailure.toolChoice).toEqual({
      type: "tool",
      toolName: "wait_for_agents",
    });

    let gateLookupFails = false;
    const gateLookupFailureStream = (await createAgentStream(
      "test-model",
      createTestStreamContext({
        tools: { wait_for_agents: {} },
        usageTracker,
        summarizationTracker,
        subagentCompletionGate: {
          getState: jest.fn(async () => {
            if (gateLookupFails) throw new Error("lookup unavailable");
            return { activeCount: 1, unconsumedSubagentIds: [] };
          }),
          markInjected: jest.fn(async () => undefined),
          markConsumed: jest.fn(async () => undefined),
        },
      }) as any,
      initAgentStreamState([uiMessage("initial", "Delegate")], {
        usedTokens: 1_000,
        maxTokens: 128_000,
      }),
    )) as any;

    await gateLookupFailureStream.prepareStep({
      steps: [{ toolResults: [{ toolName: "create_agent", output: {} }] }],
      messages: [{ role: "user", content: "Delegate" }],
    });
    gateLookupFails = true;
    const lookupFailure = await gateLookupFailureStream.prepareStep({
      steps: [{ toolResults: [] }],
      messages: [{ role: "user", content: "Delegate" }],
    });
    expect(lookupFailure.toolChoice).toEqual({
      type: "tool",
      toolName: "wait_for_agents",
    });
    warn.mockRestore();
  });

  it("keeps a delivery claim pending when the consumption acknowledgement fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const deliveryClaim = { subagent_id: "sa_1", claim_id: "claim_1" };
    const completionState = {
      activeCount: 0,
      unconsumedSubagentIds: ["sa_1"],
    };
    const markConsumed = jest.fn(async () => {
      throw new Error("persistence unavailable");
    });
    const stream = (await createAgentStream(
      "test-model",
      createTestStreamContext({
        tools: { wait_for_agents: {} },
        summarizationTracker: {
          hasSummarized: false,
          summarizationCount: 0,
        },
        usageTracker: {
          setAuthoritativeModelCostForStep: jest.fn(),
          computeCostDollars: jest.fn(() => 0),
        },
        subagentCompletionGate: {
          getState: jest.fn(async () => completionState),
          markInjected: jest.fn(async () => undefined),
          markConsumed,
        },
      }) as any,
      initAgentStreamState([uiMessage("initial", "Delegate")], {
        usedTokens: 1_000,
        maxTokens: 128_000,
      }),
    )) as any;

    await stream.prepareStep({
      steps: [
        {
          toolResults: [
            {
              toolName: "wait_for_agents",
              output: { _delivery_claim: deliveryClaim },
            },
          ],
        },
      ],
      messages: [{ role: "user", content: "Delegate" }],
    });
    await expect(
      stream.onStepFinish({
        usage: undefined,
        response: { modelId: "test-model" },
        providerMetadata: undefined,
      }),
    ).resolves.toBeUndefined();

    const blocked = await stream.prepareStep({
      steps: [{ toolResults: [] }],
      messages: [{ role: "user", content: "Delegate" }],
    });
    expect(markConsumed).toHaveBeenCalledWith([deliveryClaim]);
    expect(blocked.toolChoice).toEqual({
      type: "tool",
      toolName: "wait_for_agents",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("subagent_result_consumption_ack_failed"),
    );
    warn.mockRestore();
  });

  it.each([
    ["model-grok-4.5", "model-deepseek-v4-flash-0731"],
    ["model-grok-4.5-pro", "model-deepseek-v4-pro-0813"],
  ])(
    "switches %s back to %s after a text-only persisted summary",
    async (visionModel, textModel) => {
      const summary = uiMessage("summary", "The image findings are preserved.");
      mockRunSummarizationStep.mockResolvedValue({
        summarizationAttempted: true,
        needsSummarization: true,
        summarizedMessages: [summary],
      });
      const tracker = {
        hasSummarized: false,
        summarizationCount: 0,
        recordSummarization() {
          this.hasSummarized = true;
          this.summarizationCount++;
        },
      };
      const state = initAgentStreamState(
        [uiMessage("initial", "Inspect the attached image")],
        { usedTokens: 120_000, maxTokens: 128_000 },
      );
      const stream = (await createAgentStream(
        visionModel,
        createTestStreamContext({
          trackedProvider: {
            languageModel: (name: string) => ({ modelId: name }),
          },
          summarizationTracker: tracker,
          usageTracker: {},
        }) as any,
        state,
      )) as any;

      const continued = await stream.prepareStep({
        steps: [],
        messages: [{ role: "user", content: "Inspect the attached image" }],
      });

      expect(continued.model.modelId).toBe(textModel);
    },
  );

  it("keeps the Standard vision route when the persisted summary retains an image", async () => {
    const summaryWithImage = {
      id: "summary-with-image",
      role: "user",
      parts: [
        { type: "text", text: "Recent visual context" },
        {
          type: "file",
          mediaType: "image/png",
          url: "data:image/png;base64,aW1hZ2U=",
        },
      ],
    } as UIMessage;
    mockRunSummarizationStep.mockResolvedValue({
      summarizationAttempted: true,
      needsSummarization: true,
      summarizedMessages: [summaryWithImage],
    });
    const tracker = {
      hasSummarized: false,
      summarizationCount: 0,
      recordSummarization() {
        this.hasSummarized = true;
        this.summarizationCount++;
      },
    };
    const state = initAgentStreamState(
      [uiMessage("initial", "Inspect the attached image")],
      { usedTokens: 120_000, maxTokens: 128_000 },
    );
    const stream = (await createAgentStream(
      "model-grok-4.5",
      createTestStreamContext({
        trackedProvider: {
          languageModel: (name: string) => ({ modelId: name }),
        },
        summarizationTracker: tracker,
        usageTracker: {},
      }) as any,
      state,
    )) as any;

    const continued = await stream.prepareStep({
      steps: [],
      messages: [{ role: "user", content: "Inspect the attached image" }],
    });

    expect(continued.model.modelId).toBe("model-grok-4.5");
  });

  it("switches back after text-only rolling compaction", async () => {
    const summary = uiMessage("rolling-summary", "Visual findings preserved.");
    mockCompactModelMessagesInRun.mockResolvedValue({
      summaryMessage: summary,
      summaryText: "Visual findings preserved.",
      summarizationUsage: { inputTokens: 10, outputTokens: 2 },
    });
    mockGetProviderPromptPressure.mockReturnValue({
      reason: "serialized_message_bytes",
      reasons: [],
    });
    const tracker = {
      hasSummarized: true,
      summarizationCount: 1,
      recordSummarization() {
        this.summarizationCount++;
      },
    };
    const state = initAgentStreamState(
      [uiMessage("initial", "old visual context")],
      { usedTokens: 120_000, maxTokens: 128_000 },
    );
    const stream = (await createAgentStream(
      "model-grok-4.5-pro",
      createTestStreamContext({
        trackedProvider: {
          languageModel: (name: string) => ({ modelId: name }),
        },
        summarizationTracker: tracker,
        usageTracker: {},
      }) as any,
      state,
    )) as any;

    const continued = await stream.prepareStep({
      steps: [{ toolResults: [] }],
      messages: [
        { role: "user", content: "old visual context ".repeat(4_000) },
        { role: "assistant", content: "continue" },
      ],
    });

    expect(continued.model.modelId).toBe("model-deepseek-v4-pro-0813");
  });

  it.each(["ask", "agent"] as const)(
    "keeps authorization provider-only across %s serialization and later steps",
    async (mode) => {
      const originalMessage = uiMessage("initial", "Continua in italiano");
      const state = initAgentStreamState([originalMessage], {
        usedTokens: 1_000,
        maxTokens: 128_000,
      });
      const stream = (await createAgentStream(
        "test-model",
        createTestStreamContext({
          mode,
          platformAuthorized: true,
          summarizationTracker: {
            hasSummarized: false,
            summarizationCount: 0,
          },
          usageTracker: {},
        }) as any,
        state,
      )) as any;

      expect(stream.messages).toEqual([
        {
          role: "user",
          content: `Continua in italiano ${PLATFORM_AUTHORIZATION_ANNOTATION}`,
        },
      ]);
      expect(originalMessage.parts[0]).toEqual({
        type: "text",
        text: "Continua in italiano",
      });

      const nextStep = await stream.prepareStep({
        steps: [{ toolResults: [] }],
        messages: [
          ...stream.messages,
          { role: "assistant", content: "Analisi" },
          { role: "user", content: "Continua" },
        ],
      });
      const serialized = JSON.stringify(nextStep.messages);

      expect(serialized.match(/<platform_authorization>/g)).toHaveLength(1);
      expect(nextStep.messages.at(-1)).toEqual({
        role: "user",
        content: `Continua ${PLATFORM_AUTHORIZATION_ANNOTATION}`,
      });
    },
  );

  it("emits sanitized provider and retained-message diagnostics", async () => {
    const onProviderRequestDiagnostics = jest.fn();
    const tracker = {
      hasSummarized: true,
      summarizationCount: 2,
    };
    const state = initAgentStreamState(
      [
        uiMessage("initial-1", "private initial content"),
        uiMessage("initial-2", "more private content"),
      ],
      { usedTokens: 1_000, maxTokens: 128_000 },
    );
    state.transcriptSourceMessages = [
      uiMessage("transcript-1", "private transcript content"),
    ];

    await createAgentStream(
      "test-model",
      createTestStreamContext({
        summarizationTracker: tracker,
        usageTracker: {},
        onProviderRequestDiagnostics,
      }) as any,
      state,
    );

    expect(onProviderRequestDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "initial",
        message_count: 2,
        role_counts: { user: 2 },
        serialized_message_bytes: expect.any(Number),
      }),
      {
        raw_message_count: 2,
        rolling_message_count: 2,
        final_ui_message_count: 2,
        transcript_source_message_count: 1,
        summarization_count: 2,
        compaction_attempt_count: 0,
      },
    );
    expect(
      JSON.stringify(onProviderRequestDiagnostics.mock.calls),
    ).not.toContain("private initial content");
    expect(
      JSON.stringify(onProviderRequestDiagnostics.mock.calls),
    ).not.toContain("private transcript content");
  });

  it("emits retained-message diagnostics on prepare-step fallback", async () => {
    const onProviderRequestDiagnostics = jest.fn();
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockGetProviderPromptPressure.mockImplementationOnce(() => {
      throw new Error("pressure inspection failed");
    });
    const state = initAgentStreamState(
      [uiMessage("initial", "initial message")],
      { usedTokens: 1_000, maxTokens: 128_000 },
    );

    try {
      const stream = (await createAgentStream(
        "test-model",
        createTestStreamContext({
          summarizationTracker: {
            hasSummarized: false,
            summarizationCount: 0,
          },
          usageTracker: {},
          onProviderRequestDiagnostics,
        }) as any,
        state,
      )) as any;
      const rawMessages: ModelMessage[] = [
        { role: "user", content: "initial message" },
        { role: "assistant", content: "partial response" },
      ];

      await stream.prepareStep({
        steps: [{ toolResults: [] }],
        messages: rawMessages,
      });

      expect(onProviderRequestDiagnostics).toHaveBeenCalledTimes(2);
      expect(onProviderRequestDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          source: "prepare_step",
          step_index: 2,
          message_count: 2,
        }),
        {
          raw_message_count: 2,
          rolling_message_count: 2,
          final_ui_message_count: 1,
          transcript_source_message_count: 0,
          summarization_count: 0,
          compaction_attempt_count: 0,
        },
      );
    } finally {
      consoleError.mockRestore();
    }
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
