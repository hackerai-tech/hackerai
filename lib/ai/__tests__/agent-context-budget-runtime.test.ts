/**
 * Runs the shared Agent stream runner for paid Auto/Standard runs and checks
 * that the initial request, prepareStep, compaction and retries all use the
 * default 480K policy, bounded by the actual route.
 */
import type { ModelMessage, UIMessage } from "ai";
import { deserialize, serialize } from "node:v8";
import { phLogger } from "@/lib/posthog/server";
import { getAgentContextPolicy } from "@/lib/ai/agent-context-budget";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";

const originalClone = globalThis.structuredClone;
beforeAll(() => {
  globalThis.structuredClone = <T>(value: T): T =>
    deserialize(serialize(value));
});
afterAll(() => {
  globalThis.structuredClone = originalClone;
});

const mockStreamText = jest.fn();
const mockRunSummarizationStep = jest.fn();
const mockCompactModelMessagesInRun = jest.fn();
const mockFallbackSlugs = jest.fn((): string[] => []);
const mockFlag = jest.fn(async () => false);

jest.mock("server-only", () => ({}));
jest.mock("@/lib/ai/abliteration", () => ({
  ...jest.requireActual("@/lib/ai/abliteration"),
  isAbliterationConfigured: () => false,
}));
jest.mock("@/lib/db/model-history", () => ({
  ModelHistoryTimeoutError: jest.requireActual("@/lib/db/model-history")
    .ModelHistoryTimeoutError,
  loadModelHistory: jest.fn(async () => null),
  saveModelHistory: jest.fn(),
}));
jest.mock("@/lib/posthog/server", () => ({
  getPostHogBooleanFlagDecisionForUser: () => mockFlag(),
  getPostHogFeatureFlagForUser: () => mockFlag(),
  phLogger: { event: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock("ai", () => ({
  asSchema: jest.requireActual("ai").asSchema,
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
  generateText: jest.fn(),
  wrapLanguageModel: jest.fn(({ model }) => model),
}));
jest.mock("@/lib/api/chat-stream-helpers", () => ({
  getAppendedNotesUpdate: jest.fn(),
  applyPrepareStepReminders: async (messages: ModelMessage[]) => messages,
  buildProviderOptions: () => ({}),
  buildSystemPrompt: (prompt: string) => prompt,
  getFallbackSlugs: () => mockFallbackSlugs(),
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
  getProviderPromptPressure: () => null,
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
  pruneToolOutputs: (messages: UIMessage[]) => ({ messages, prunedCount: 0 }),
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
  ...jest.requireActual("@/lib/chat/multimodal-tool-result-recovery"),
  uiMessagesContainImageViewResult: jest.fn(() => false),
}));
jest.mock("@/lib/ai/providers", () => ({
  isAnthropicModel: () => false,
  isDeepSeekModel: (modelName: string) =>
    modelName.startsWith("model-deepseek-v4"),
  PDF_PARSER_ENGINE_HEADER: "x-hackerai-openrouter-pdf-parser-engine",
  PDF_PARSER_RECOVERY_HEADER: "x-hackerai-openrouter-pdf-parser-recovery",
}));
jest.mock("@/lib/ai/tools/utils/pty-session-manager", () => ({
  ptySessionManager: {
    closeAllSessions: jest.fn(),
    closeAll: jest.fn(async () => undefined),
  },
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
jest.mock("@/lib/utils/error-utils", () => ({
  ...jest.requireActual("@/lib/utils/error-utils"),
  classifyProviderOverflowError: () => null,
  isProviderContentBlockedFinishReasonError: () => false,
}));

const {
  createAgentStream,
  initAgentStreamState,
}: typeof import("@/lib/api/agent-stream-runner") = require("@/lib/api/agent-stream-runner");

const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017";
// The real paid Auto/Standard text route: 1017 plus its transparent fallbacks.
const FULL_ROUTE = [
  "z-ai/glm-5.3-flash",
  "deepseek/deepseek-v4-pro-0813",
  "z-ai/glm-5.3",
];
const MESSAGES = [{ role: "user", content: "Continue" }];
const PAID = ["pro", "pro-plus", "ultra", "team"] as const;
const SELECTIONS = [
  undefined,
  "auto",
  "hackerai-standard",
  "hackerai-pro",
  "hackerai-max",
] as const;

// The retired experiment's exposure event and attribution must not return.
const experimentTelemetry = () =>
  jest
    .mocked(phLogger.event)
    .mock.calls.filter(
      ([name, properties]) =>
        name === "agent_model_context_exposed" ||
        JSON.stringify(properties).includes("paid_agent_context"),
    );

const newState = () =>
  initAgentStreamState(
    [
      {
        id: "initial",
        role: "user",
        parts: [{ type: "text", text: "Continue" }],
      },
    ],
    { usedTokens: 1_000, maxTokens: 276_000 },
  );

const createContext = (overrides: Record<string, unknown> = {}) => ({
  trackedProvider: { languageModel: () => ({ modelId: DEEPSEEK }) },
  currentSystemPrompt: "system",
  tools: {},
  mode: "agent",
  endpoint: "agent",
  userId: "user",
  subscription: "pro",
  chatId: "chat",
  triggerRunId: "run-1",
  fileTokens: {},
  noteInjectionOpts: {
    userId: "user",
    subscription: "pro",
    shouldIncludeNotes: false,
  },
  systemPromptTokens: 100,
  ctxSystemTokens: 100,
  ctxMaxTokens: 276_000,
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
  usageTracker: {},
  summarizationTracker: { hasSummarized: false, summarizationCount: 0 },
  getHardTimeoutReason: () => null,
  ...overrides,
});

type TestStream = {
  prepareStep: (args: unknown) => Promise<unknown>;
  experimental_onStepStart: (args: unknown) => void;
};
const start = async (
  ctx: ReturnType<typeof createContext>,
  state: ReturnType<typeof newState>,
) =>
  (await createAgentStream(
    "model-deepseek-v4-flash-vision-pro",
    ctx as never,
    state,
  )) as unknown as TestStream;

beforeEach(() => {
  jest.clearAllMocks();
  mockFallbackSlugs.mockReturnValue(FULL_ROUTE);
  mockRunSummarizationStep.mockResolvedValue({
    summarizationAttempted: false,
    needsSummarization: false,
  });
  mockCompactModelMessagesInRun.mockResolvedValue(null);
  mockStreamText.mockImplementation((options) => options);
});

describe("agent context policy", () => {
  it.each(
    (["free", ...PAID] as const).flatMap((subscription) =>
      (["agent", "ask"] as const).flatMap((mode) =>
        SELECTIONS.map((selected) => ({ subscription, mode, selected })),
      ),
    ),
  )(
    "$subscription $mode selector=$selected",
    ({
      subscription,
      mode,
      selected,
    }: {
      subscription: SubscriptionTier;
      mode: ChatMode;
      selected: SelectedModel | undefined;
    }) => {
      const paidAgent = subscription !== "free" && mode === "agent";
      const explicit =
        selected === "hackerai-pro" || selected === "hackerai-max";
      expect(
        getAgentContextPolicy({
          subscription,
          mode,
          selectedModelOverride: selected,
        }),
      ).toBe(!paidAgent ? "baseline" : explicit ? "expanded" : "paid_480k");
    },
  );
});

describe("paid 480K context through the shared Agent runner", () => {
  it("uses one 480K policy for the request, compaction and retries without an assignment", async () => {
    const state = newState();
    const ctx = createContext();
    const first = await start(ctx, state);
    expect(state.ctxUsage.maxTokens).toBe(500_000);

    await first.prepareStep({ steps: [], stepNumber: 0, messages: MESSAGES });
    expect(mockRunSummarizationStep).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ctxMaxTokens: 500_000,
        preparedInputTokens: expect.any(Number),
      }),
    );
    expect(await state.compactionPolicy!.resolve()).toMatchObject({
      expandedAgentContext: true,
      policy: "paid_480k_large_v2_context_v1",
    });
    first.experimental_onStepStart({ model: { modelId: DEEPSEEK } });

    const retry = await start(ctx, state);
    await retry.prepareStep({ steps: [], stepNumber: 0, messages: MESSAGES });
    expect(mockRunSummarizationStep).toHaveBeenLastCalledWith(
      expect.objectContaining({ ctxMaxTokens: 500_000 }),
    );
    retry.experimental_onStepStart({ model: { modelId: DEEPSEEK } });
    expect(experimentTelemetry()).toEqual([]);
  });

  it.each(
    PAID.flatMap((subscription) =>
      ([undefined, "auto", "hackerai-standard"] as const).map((selected) => ({
        subscription,
        selected,
      })),
    ),
  )(
    "applies 480K to $subscription selector=$selected",
    async ({ subscription, selected }) => {
      const state = newState();
      const stream = await start(
        createContext({ subscription, selectedModelOverride: selected }),
        state,
      );
      await stream.prepareStep({
        steps: [],
        stepNumber: 0,
        messages: MESSAGES,
      });
      expect(state.ctxUsage.maxTokens).toBe(500_000);
      expect(mockRunSummarizationStep).toHaveBeenLastCalledWith(
        expect.objectContaining({ ctxMaxTokens: 500_000 }),
      );
      expect((await state.compactionPolicy!.resolve()).policy).toBe(
        "paid_480k_large_v2_context_v1",
      );
    },
  );

  it.each([
    ["a smaller transparent fallback", ["x-ai/grok-4.6"], 468_000],
    ["an unverified fallback", ["vendor/unknown-model"], 276_000],
  ])("bounds the budget by %s", async (_label, fallbacks, budget) => {
    mockFallbackSlugs.mockReturnValue(fallbacks);
    const state = newState();
    const stream = await start(createContext(), state);
    expect(state.ctxUsage.maxTokens).toBe(budget);
    await stream.prepareStep({ steps: [], stepNumber: 0, messages: MESSAGES });
    expect(mockRunSummarizationStep).toHaveBeenLastCalledWith(
      expect.objectContaining({ ctxMaxTokens: budget }),
    );
  });

  it("refuses to send a prompt that fits 500K to a route with a 500K member", async () => {
    mockRunSummarizationStep.mockResolvedValue({
      summarizationAttempted: true,
      needsSummarization: false,
    });
    const text = " ordinary".repeat(474_000);
    const messages = [{ role: "user", content: text }];
    const fits = await start(createContext(), newState());
    await expect(
      fits.prepareStep({ steps: [], stepNumber: 0, messages }),
    ).resolves.toBeDefined();

    mockFallbackSlugs.mockReturnValue([...FULL_ROUTE, "x-ai/grok-4.6"]);
    const overflow = await start(createContext(), newState());
    await expect(
      overflow.prepareStep({ steps: [], stepNumber: 0, messages }),
    ).rejects.toThrow(
      "Conversation could not be compacted to fit the selected model",
    );
  });

  it("counts tool schemas in the final send guard near the 468K route edge", async () => {
    mockRunSummarizationStep.mockResolvedValue({
      summarizationAttempted: true,
      needsSummarization: false,
    });
    const { jsonSchema } = jest.requireActual<typeof import("ai")>("ai");
    // ~20K tokens of schema that is sent with every request.
    const tools = {
      run_terminal_cmd: {
        description: " field".repeat(20_000),
        inputSchema: jsonSchema({
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        }),
      },
    };
    // Messages plus system stay below 468K on their own.
    const messages = [{ role: "user", content: " ordinary".repeat(458_000) }];
    const fits = await start(createContext({ tools }), newState());
    await expect(
      fits.prepareStep({ steps: [], stepNumber: 0, messages }),
    ).resolves.toBeDefined();

    mockFallbackSlugs.mockReturnValue([...FULL_ROUTE, "x-ai/grok-4.6"]);
    const state = newState();
    const overflow = await start(createContext({ tools }), state);
    expect(state.ctxUsage.maxTokens).toBe(468_000);
    await expect(
      overflow.prepareStep({ steps: [], stepNumber: 0, messages }),
    ).rejects.toThrow(
      "Conversation could not be compacted to fit the selected model",
    );
  });

  it("compacts in-run when tool schemas push a request past the 480K trigger", async () => {
    const { jsonSchema } = jest.requireActual<typeof import("ai")>("ai");
    // ~45K tokens of schema that is sent with every request.
    const tools = {
      run_terminal_cmd: {
        description: " field".repeat(45_000),
        inputSchema: jsonSchema({
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        }),
      },
    };
    mockCompactModelMessagesInRun.mockResolvedValue({
      summaryMessage: {
        id: "summary",
        role: "user",
        parts: [
          {
            type: "text",
            text: "<context_summary>Scan reviewed</context_summary>",
          },
        ],
      },
      summarizationUsage: {},
    });
    const state = newState();
    const stream = await start(
      createContext({
        tools,
        summarizationTracker: {
          hasSummarized: false,
          summarizationCount: 0,
          recordSummarization: jest.fn(),
          recordSummarizationUsage: jest.fn(),
        },
      }),
      state,
    );
    expect(state.ctxUsage.maxTokens).toBe(500_000);
    // Messages and system alone stay below the 480K trigger; with the schema
    // the request exceeds the 500K send guard unless it is compacted first.
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: `Review the scan${" ordinary".repeat(465_000)}`,
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "scan",
            toolName: "run_terminal_cmd",
            input: { command: "cat scan.txt" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "scan",
            toolName: "run_terminal_cmd",
            output: { type: "text", value: "scan parsed" },
          },
        ],
      },
    ];

    const prepared = (await stream.prepareStep({
      steps: [{ toolResults: [] }],
      stepNumber: 1,
      messages,
    })) as { messages: ModelMessage[] };

    expect(mockCompactModelMessagesInRun).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(prepared.messages);
    expect(sent).toContain("Scan reviewed");
    expect(sent).not.toContain("Review the scan");
  });

  it.each([
    [
      "explicit Pro",
      { selectedModelOverride: "hackerai-pro", agentModelContextEnabled: true },
      496_000,
      "pro_large_v2_context_v1",
    ],
    [
      "explicit Max",
      { selectedModelOverride: "hackerai-max", agentModelContextEnabled: true },
      496_000,
      "max_large_v2_context_v1",
    ],
    // A selector without the caller's expanded snapshot stays at baseline.
    ["unentitled Max", { selectedModelOverride: "hackerai-max" }, 276_000, ""],
    ["Free", { subscription: "free" }, 276_000, ""],
    ["Ask", { mode: "ask" }, 276_000, ""],
  ])(
    "keeps %s outside the paid 480K policy",
    async (_label, overrides, budget, expandedPolicy) => {
      const state = newState();
      const stream = await start(createContext(overrides), state);
      await stream.prepareStep({
        steps: [],
        stepNumber: 0,
        messages: MESSAGES,
      });
      expect(state.ctxUsage.maxTokens).toBe(budget);
      const { policy } = await state.compactionPolicy!.resolve();
      if (expandedPolicy) expect(policy).toBe(expandedPolicy);
      else expect(policy).not.toMatch(/paid_480k|max_|pro_/);
    },
  );

  it("keeps the explicit Pro context exposure under its own flag", async () => {
    const stream = await start(
      createContext({
        selectedModelOverride: "hackerai-pro",
        agentModelContextEnabled: true,
        agentModelContextVariant: "test",
      }),
      newState(),
    );
    stream.experimental_onStepStart({ model: { modelId: DEEPSEEK } });
    const exposures = jest
      .mocked(phLogger.event)
      .mock.calls.filter(([name]) => name === "agent_model_context_exposed");
    expect(exposures).toHaveLength(1);
    expect(exposures[0][1]).toMatchObject({
      flag_key: "agent_pro_context_v1",
      context_max_tokens: 496_000,
    });
  });
});
