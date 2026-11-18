/**
 * The shared Ask/Agent completion boundary: the factory's actual streamText
 * onFinish must not settle a run while its selected local host is unverified.
 * Provider, persistence and PTY IO are mocked; the stop signal is the one the
 * Trigger worker uses.
 */
import { LocalConnectionLostError } from "@/lib/chat/local-connection-stop";
import { createAgentStopSignal } from "@/lib/chat/agent-stop-signal";
import { BrowserHandoffAbandonedError } from "@/lib/chat/manual-agent-resume";
import type { ModelMessage, UIMessage } from "ai";

const mockStreamText = jest.fn();
const mockCloseAll = jest.fn(async (_chatId: string) => undefined);
jest.mock("server-only", () => ({}));
jest.mock("@/lib/db/actions", () => ({}));
jest.mock("@/lib/db/model-history", () => ({
  ModelHistoryTimeoutError: class extends Error {},
  loadModelHistory: jest.fn(async () => null),
  saveModelHistory: jest.fn(async () => "saved"),
}));
jest.mock("@/lib/posthog/server", () => ({
  getPostHogBooleanFlagDecisionForUser: jest.fn(async () => false),
  getPostHogFeatureFlagForUser: jest.fn(async () => false),
  phLogger: { event: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock("ai", () => ({
  asSchema: jest.requireActual("ai").asSchema,
  convertToModelMessages: jest.fn(async (messages: UIMessage[]) =>
    messages.map((message) => ({ role: message.role, content: "" })),
  ),
  stepCountIs: jest.fn(() => () => false),
  streamText: (options: unknown) => mockStreamText(options),
  generateText: jest.fn(),
  wrapLanguageModel: jest.fn(({ model }) => model),
}));
jest.mock("@/lib/api/chat-stream-helpers", () => ({
  getAppendedNotesUpdate: jest.fn(),
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
  runSummarizationStep: jest.fn(),
}));
jest.mock("@/lib/chat/summarization", () => ({
  compactModelMessagesInRun: jest.fn(),
}));
jest.mock("@/lib/chat/summarization/provider-pressure", () => ({
  getProviderPromptPressure: () => null,
}));
jest.mock("@/lib/chat/agent-long-provider-retry", () => ({
  createAssistantContentLoopMonitor: () => ({ appendDelta: jest.fn() }),
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
jest.mock("@/lib/ai/providers", () => ({
  isAnthropicModel: () => false,
  isDeepSeekModel: () => false,
  PDF_PARSER_ENGINE_HEADER: "x-hackerai-openrouter-pdf-parser-engine",
  PDF_PARSER_RECOVERY_HEADER: "x-hackerai-openrouter-pdf-parser-recovery",
}));
jest.mock("@/lib/ai/tools/utils/pty-session-manager", () => ({
  ptySessionManager: {
    closeAllSessions: jest.fn(),
    closeAll: (chatId: string) => mockCloseAll(chatId),
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
jest.mock("@/lib/provider-usage-cost", () => ({
  ...jest.requireActual("@/lib/provider-usage-cost"),
  getOpenRouterUpstreamInferenceCostFromUsageRaw: () => undefined,
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

type Confirm = (signal?: AbortSignal) => Promise<void>;

/** The Trigger worker's stop signal and a sandbox manager with confirmation. */
async function finishableRun(
  confirmLocalConnection?: Confirm,
  overrides: Record<string, unknown> = {},
) {
  const state = initAgentStreamState(
    [{ id: "u", role: "user", parts: [{ type: "text", text: "Scan" }] }],
    { usedTokens: 1_000, maxTokens: 128_000 },
  );
  const stop = createAgentStopSignal({
    onAbort: () => {},
    getStreamState: () => state,
  });
  const stream = await createAgentStream(
    "test-model",
    {
      trackedProvider: { languageModel: () => ({ modelId: "test-model" }) },
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
      abortController: stop.controller,
      budgetMonitor: null,
      sandboxManager: {
        getSandboxType: () => undefined,
        supportsInteractivePty: async () => true,
        ...(confirmLocalConnection && { confirmLocalConnection }),
      },
      getTodoManager: () => ({ getAllTodos: () => [] }),
      ensureSandbox: jest.fn(),
      chatLogger: undefined,
      usageRefundTracker: { refund: jest.fn(async () => undefined) },
      usageTracker: {
        hasUsage: true,
        setAuthoritativeModelCostForStep: jest.fn(),
      },
      summarizationTracker: { hasSummarized: false, summarizationCount: 0 },
      getHardTimeoutReason: () => null,
      ...overrides,
    } as never,
    state,
  );
  const finish = (finishReason = "stop") =>
    (
      stream as unknown as {
        onFinish: (result: unknown) => Promise<void>;
      }
    ).onFinish({
      finishReason,
      usage: {},
      response: { modelId: "test-model" },
    });
  return { state, stop, finish };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const settled = (promise: Promise<unknown>) => {
  const outcome = { done: false, error: undefined as unknown };
  promise.then(
    () => (outcome.done = true),
    (error) => Object.assign(outcome, { done: true, error }),
  );
  return outcome;
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  mockStreamText.mockReset();
  mockStreamText.mockImplementation((options) => options);
  mockCloseAll.mockClear();
});

test("a finished model waits for fresh proof of its host, then completes once", async () => {
  const proof = deferred();
  const order: string[] = [];
  mockCloseAll.mockImplementation(async () => {
    order.push("terminals_closed");
  });
  const confirm = jest.fn((_signal?: AbortSignal) => {
    order.push("confirm");
    return proof.promise;
  });
  const run = await finishableRun(confirm);
  const finished = settled(run.finish());
  await flush();
  // The host is unverified: no completion reason exists yet.
  expect(finished.done).toBe(false);
  expect(run.state.streamFinishReason).toBeUndefined();
  // Terminals close first, so a healthy open one is a known outcome.
  expect(order).toEqual(["terminals_closed", "confirm"]);

  proof.resolve();
  await flush();
  expect(finished).toEqual({ done: true, error: undefined });
  expect(run.state.streamFinishReason).toBe("stop");
  expect(confirm).toHaveBeenCalledTimes(1);
});

test.each([
  ["the run's stop signal records it first", true],
  ["only the confirmation reports it", false],
])(
  "a loss during confirmation finishes as local-connection-lost when %s",
  async (_name, signalled) => {
    const loss = new LocalConnectionLostError("selected_host_recovery_expired");
    const proof = deferred();
    const run = await finishableRun(() => proof.promise);
    const finished = settled(run.finish("content-filter"));
    await flush();
    // As the manager's onLost does: the worker's stop records the cause.
    if (signalled) run.stop.abort("local_connection_lost", loss);
    proof.reject(loss);
    await flush();
    expect(finished).toEqual({ done: true, error: undefined });
    expect(run.state.streamFinishReason).toBe("local-connection-lost");
    // Provider refusal history from before the stop is kept.
    expect(run.state.providerTerminalFinishReasonBeforeAbort).toBe(
      "content-filter",
    );
    if (signalled) {
      expect(run.stop.source).toBe("local_connection_lost");
      expect(run.stop.controller.signal.reason).toBe(loss);
    }
  },
);

test.each([
  [
    "a user Stop",
    async (run: Awaited<ReturnType<typeof finishableRun>>) =>
      run.stop.controller.abort(new Error("Stopped by user")),
  ],
  [
    "a budget stop",
    async (run: Awaited<ReturnType<typeof finishableRun>>) => {
      run.state.stoppedDueToBudgetExhaustion = true;
    },
  ],
  [
    "an elapsed timeout",
    async (run: Awaited<ReturnType<typeof finishableRun>>) => {
      run.state.stoppedDueToElapsedTimeout = true;
    },
  ],
])("%s never waits on the host", async (_name, stopBeforeFinish) => {
  const confirm = jest.fn(() => new Promise<void>(() => {}));
  const run = await finishableRun(confirm);
  await stopBeforeFinish(run);
  await run.finish();
  expect(confirm).not.toHaveBeenCalled();
  expect(run.state.streamFinishReason).not.toBe("local-connection-lost");
});

test("a platform hard timeout never waits on the host", async () => {
  const confirm = jest.fn(() => new Promise<void>(() => {}));
  const run = await finishableRun(confirm, {
    getHardTimeoutReason: () => "preemptive-timeout",
  });
  await run.finish();
  expect(confirm).not.toHaveBeenCalled();
  expect(run.state.streamFinishReason).toBe("preemptive-timeout");
});

test("a Stop during confirmation ends the wait without claiming a local loss", async () => {
  const run = await finishableRun(
    (signal) =>
      new Promise<void>((_, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
  );
  const finished = settled(run.finish());
  await flush();
  expect(finished.done).toBe(false);
  run.stop.controller.abort(new Error("Stopped by user"));
  await flush();
  expect(finished).toEqual({ done: true, error: undefined });
  expect(run.state.streamFinishReason).not.toBe("local-connection-lost");
});

test("a hard timeout during confirmation retains its terminal cause", async () => {
  let hardReason: string | null = null;
  const run = await finishableRun(
    (signal) =>
      new Promise<void>((_, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
    { getHardTimeoutReason: () => hardReason },
  );
  const finished = settled(run.finish());
  await flush();
  expect(finished.done).toBe(false);
  hardReason = "preemptive-timeout";
  run.stop.controller.abort(new Error("Platform timeout"));
  await flush();
  expect(finished).toEqual({ done: true, error: undefined });
  expect(run.state.streamFinishReason).toBe("preemptive-timeout");
});

test("an unwatched (Cloud or Ask) run completes without any host wait", async () => {
  const run = await finishableRun(undefined);
  await run.finish();
  expect(run.state.streamFinishReason).toBe("stop");
  expect(mockCloseAll).toHaveBeenCalledWith("chat");
});

describe("browser handoff completion gate", () => {
  /** Holds like the owned browser gate until the worker's stop aborts it. */
  const heldGate = (signal?: AbortSignal) =>
    new Promise<boolean>((_, reject) =>
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );

  test("an abandonment during the gate settles usage and saves the manual-resume reason", async () => {
    const setCost = jest.fn();
    const run = await finishableRun(undefined, {
      waitForBrowserHandoff: heldGate,
      usageTracker: {
        hasUsage: true,
        setAuthoritativeModelCostForStep: setCost,
      },
    });
    const finished = settled(run.finish("stop"));
    await flush();
    expect(finished.done).toBe(false);
    expect(setCost).not.toHaveBeenCalled();
    // As BrowserSessions' committed-abandonment callback does in the worker.
    run.stop.abort(
      "browser_handoff_abandoned",
      new BrowserHandoffAbandonedError(),
    );
    await flush();
    expect(finished).toEqual({ done: true, error: undefined });
    expect(run.state.streamFinishReason).toBe("browser-handoff-abandoned");
    expect(setCost).toHaveBeenCalled();
    expect(mockCloseAll).toHaveBeenCalledWith("chat");
  });

  test("a user Stop during the gate still propagates without the abandonment reason", async () => {
    const run = await finishableRun(undefined, {
      waitForBrowserHandoff: heldGate,
    });
    const finished = settled(run.finish("stop"));
    await flush();
    run.stop.controller.abort(new Error("Stopped by user"));
    await flush();
    expect(finished.done).toBe(true);
    expect(finished.error).toEqual(new Error("Stopped by user"));
    expect(run.state.streamFinishReason).toBeUndefined();
  });

  test.each([
    ["the abandonment", () => new BrowserHandoffAbandonedError(), true],
    ["a user Stop", () => new Error("Stopped by user"), false],
  ])(
    "labels a stream aborted by %s only from its first stop",
    async (_name, reason, abandoned) => {
      const run = await finishableRun(undefined);
      run.stop.controller.abort(reason());
      // A later abandonment callback cannot replace the first stop.
      run.stop.abort(
        "browser_handoff_abandoned",
        new BrowserHandoffAbandonedError(),
      );
      const stream = (await mockStreamText.mock.results[0].value) as {
        onAbort: (event: { steps: unknown[] }) => Promise<void>;
      };
      await stream.onAbort({ steps: [] });
      expect(run.state.streamFinishReason).toBe(
        abandoned ? "browser-handoff-abandoned" : undefined,
      );
    },
  );
});

test("an unexpected confirmation failure is never turned into success", async () => {
  const run = await finishableRun(async () => {
    throw new Error("relay misconfigured");
  });
  await expect(run.finish()).rejects.toThrow("relay misconfigured");
  expect(run.state.streamFinishReason).toBeUndefined();
});
