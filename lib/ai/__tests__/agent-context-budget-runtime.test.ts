/**
 * Runs the shared Agent stream runner with the paid 480K context snapshot and
 * checks that the initial request, prepareStep, compaction and retries agree,
 * and that actual exposure is emitted once at the first real model request.
 */
import type { ModelMessage, UIMessage } from "ai";
import { deserialize, serialize } from "node:v8";
import { phLogger } from "@/lib/posthog/server";
import type { PaidAgentContextAssignment } from "@/lib/experiments/paid-agent-context";

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

const assignment = (
  variant: "control" | "test",
): PaidAgentContextAssignment => ({
  flagKey: "paid_agent_context_480k_v1",
  variant,
  requestedSelection: "auto",
});

const exposures = () =>
  jest
    .mocked(phLogger.event)
    .mock.calls.filter(
      ([name, properties]) =>
        name === "agent_model_context_exposed" &&
        properties.flag_key === "paid_agent_context_480k_v1",
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

describe("paid 480K context through the shared Agent runner", () => {
  it("uses one 480K policy for the request, compaction and retries, exposing once", async () => {
    const state = newState();
    const ctx = createContext({ paidAgentContext: assignment("test") });
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
      policy: expect.stringMatching(/^paid_480k_/),
    });
    // Preparation and startup compaction are not exposure.
    expect(exposures()).toHaveLength(0);

    first.experimental_onStepStart({ model: { modelId: DEEPSEEK } });
    expect(exposures()).toHaveLength(1);
    expect(exposures()[0][1]).toMatchObject({
      userId: "user",
      eventUuid: expect.any(String),
      flag_key: "paid_agent_context_480k_v1",
      experiment_variant: "test",
      "$feature/paid_agent_context_480k_v1": "test",
      paid_agent_context_selection: "auto",
      paid_agent_context_max_tokens: 500_000,
      paid_agent_context_threshold_tokens: 480_000,
      paid_agent_context_480k_active: true,
      paid_agent_context_route_supports_480k: true,
      run_id: "run-1",
      model: DEEPSEEK,
    });

    const retry = await start(ctx, state);
    await retry.prepareStep({ steps: [], stepNumber: 0, messages: MESSAGES });
    expect(mockRunSummarizationStep).toHaveBeenLastCalledWith(
      expect.objectContaining({ ctxMaxTokens: 500_000 }),
    );
    retry.experimental_onStepStart({ model: { modelId: DEEPSEEK } });
    expect(exposures()).toHaveLength(1);
  });

  it("keeps the 256K control policy and exposes control at the same point", async () => {
    const state = newState();
    const stream = await start(
      createContext({ paidAgentContext: assignment("control") }),
      state,
    );
    await stream.prepareStep({ steps: [], stepNumber: 0, messages: MESSAGES });
    expect(state.ctxUsage.maxTokens).toBe(276_000);
    expect(mockRunSummarizationStep).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ctxMaxTokens: 276_000,
        preparedInputTokens: undefined,
      }),
    );
    const compaction = await state.compactionPolicy!.resolve();
    expect(compaction.expandedAgentContext).toBeUndefined();
    expect(compaction.policy).not.toMatch(/paid_480k|max_|pro_/);
    stream.experimental_onStepStart({ model: { modelId: DEEPSEEK } });
    expect(exposures()).toHaveLength(1);
    expect(exposures()[0][1]).toMatchObject({
      experiment_variant: "control",
      paid_agent_context_max_tokens: 276_000,
      paid_agent_context_threshold_tokens: 256_000,
      paid_agent_context_480k_active: false,
      paid_agent_context_route_supports_480k: true,
    });
  });

  it.each([
    ["a smaller transparent fallback", ["x-ai/grok-4.6"], 468_000],
    ["an unverified fallback", ["vendor/unknown-model"], 276_000],
  ])(
    "bounds treatment by %s and reports the route did not reach 480K",
    async (_label, fallbacks, budget) => {
      mockFallbackSlugs.mockReturnValue(fallbacks);
      const state = newState();
      const stream = await start(
        createContext({ paidAgentContext: assignment("test") }),
        state,
      );
      expect(state.ctxUsage.maxTokens).toBe(budget);
      stream.experimental_onStepStart({ model: { modelId: DEEPSEEK } });
      expect(exposures()[0][1]).toMatchObject({
        paid_agent_context_max_tokens: budget,
        paid_agent_context_480k_active: false,
        paid_agent_context_route_supports_480k: false,
      });
    },
  );

  it("refuses to send a prompt that fits 500K to a route with a 500K member", async () => {
    mockRunSummarizationStep.mockResolvedValue({
      summarizationAttempted: true,
      needsSummarization: false,
    });
    const text = " ordinary".repeat(474_000);
    const messages = [{ role: "user", content: text }];
    const fits = await start(
      createContext({ paidAgentContext: assignment("test") }),
      newState(),
    );
    await expect(
      fits.prepareStep({ steps: [], stepNumber: 0, messages }),
    ).resolves.toBeDefined();

    mockFallbackSlugs.mockReturnValue([...FULL_ROUTE, "x-ai/grok-4.6"]);
    const overflow = await start(
      createContext({ paidAgentContext: assignment("test") }),
      newState(),
    );
    await expect(
      overflow.prepareStep({ steps: [], stepNumber: 0, messages }),
    ).rejects.toThrow(
      "Conversation could not be compacted to fit the selected model",
    );
  });

  it.each([
    [
      "explicit Pro",
      { selectedModelOverride: "hackerai-pro", agentModelContextEnabled: true },
      496_000,
    ],
    ["Max", { selectedModelOverride: "hackerai-max" }, 276_000],
    ["Free", { subscription: "free" }, 276_000],
    ["Ask", { mode: "ask" }, 276_000],
  ])(
    "ignores a leaked treatment snapshot for %s",
    async (_label, overrides, budget) => {
      const state = newState();
      const stream = await start(
        createContext({ paidAgentContext: assignment("test"), ...overrides }),
        state,
      );
      await stream.prepareStep({
        steps: [],
        stepNumber: 0,
        messages: MESSAGES,
      });
      expect(state.ctxUsage.maxTokens).toBe(budget);
      expect((await state.compactionPolicy!.resolve()).policy).not.toMatch(
        /paid_480k/,
      );
      stream.experimental_onStepStart({ model: { modelId: DEEPSEEK } });
      expect(exposures()).toHaveLength(0);
    },
  );

  it("does not expose a request aborted before the first model step", async () => {
    const ctx = createContext({ paidAgentContext: assignment("test") });
    const stream = await start(ctx, newState());
    ctx.abortController.abort();
    stream.experimental_onStepStart({ model: { modelId: DEEPSEEK } });
    expect(exposures()).toHaveLength(0);
    expect(ctx.paidAgentContext).not.toHaveProperty("exposure");
  });
});
