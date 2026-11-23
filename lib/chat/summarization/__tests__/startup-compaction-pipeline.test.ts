import { MockLanguageModelV3 } from "ai/test";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { APICallError, type UIMessage, type UIMessageStreamWriter } from "ai";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { deserialize, serialize } from "node:v8";

// jsdom omits this Node/Web API used by the real SDK's successful result path.
const cloneDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "structuredClone",
);
Object.defineProperty(globalThis, "structuredClone", {
  configurable: true,
  value: <T>(value: T): T => deserialize(serialize(value)),
});
afterAll(() => {
  if (cloneDescriptor)
    Object.defineProperty(globalThis, "structuredClone", cloneDescriptor);
  else Reflect.deleteProperty(globalThis, "structuredClone");
});

const models = new Map<string, LanguageModel>();
const saveSummary = jest.fn(async (_args: unknown) => undefined);
jest.doMock("server-only", () => ({}));
jest.doMock("@/lib/db/actions", () => ({
  saveChatSummary: saveSummary,
  attachChatSummaryTranscript: async () => true,
}));
jest.doMock("@/lib/ai/providers", () => ({
  KIMI_K3_SLUG: "synthetic-fallback",
  myProvider: { languageModel: (name: string) => models.get(name) },
}));
const mockInferenceConfigured = jest.fn(() => false);
jest.doMock("@/lib/ai/inference", () => ({
  ...jest.requireActual<typeof import("@/lib/ai/inference")>(
    "@/lib/ai/inference",
  ),
  isInferenceConfigured: () => mockInferenceConfigured(),
}));
const mockFlag = jest.fn<() => Promise<boolean | null>>();
const recordEvent = jest.fn();
jest.doMock("@/lib/posthog/server", () => ({
  phLogger: { event: recordEvent },
  getPostHogBooleanFlagDecisionForUser: mockFlag,
}));
const { CompactionModelPolicy } =
  require("../compaction-policy") as typeof import("../compaction-policy");
const { AGENT_SUMMARIZATION_PROMPT, ASK_SUMMARIZATION_PROMPT } =
  require("../prompts") as typeof import("../prompts");
const { checkAndSummarizeIfNeeded, compactModelMessagesInRun } =
  require("../index") as typeof import("../index");

const DEEPSEEK_1017 = "model-deepseek-v4.1-flash-1017-pro";
const INFERENCE = "model-inference-cyber";
const enableInference = () => {
  mockInferenceConfigured.mockReturnValue(true);
  mockFlag.mockResolvedValue(true);
};

const jsonCheckpoint = (mode: "ask" | "agent", body: string) =>
  JSON.stringify(
    Object.fromEntries(
      [
        ...new Set(
          (mode === "agent"
            ? AGENT_SUMMARIZATION_PROMPT
            : ASK_SUMMARIZATION_PROMPT
          ).match(/^## .+$/gm)!,
        ),
      ].map((header) => [header.slice(3), body]),
    ),
  );

const summary = () => ({
  content: [
    {
      type: "text" as const,
      text: "Synthetic complete checkpoint: pending check C; no network access.",
    },
  ],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: {
    inputTokens: {
      total: 100,
      noCache: 100,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 20, text: 20, reasoning: undefined },
  },
  warnings: [],
});
const messages: UIMessage[] = Array.from({ length: 6 }, (_, index) => ({
  id: `synthetic-${index}`,
  role: index % 2 ? "assistant" : "user",
  parts: [
    {
      type: "text",
      text: `Synthetic state ${index}: pending check C; no network access.`,
    },
  ],
}));

describe("startup compaction through the real AI SDK", () => {
  let primary: MockLanguageModelV3;
  let fallback: MockLanguageModelV3;
  let finalFallback: MockLanguageModelV3;
  let writer: UIMessageStreamWriter;
  const start = (signal?: AbortSignal) =>
    checkAndSummarizeIfNeeded({
      uiMessages: messages,
      subscription: "pro",
      languageModel: primary,
      mode: "agent",
      writer,
      chatId: "synthetic-sdk-acceptance",
      abortSignal: signal,
      startupCompaction: {},
      providerPromptPressure: {
        reason: "serialized_message_bytes",
        reasons: ["serialized_message_bytes"],
        toolResultCount: 0,
        messageCount: 120,
        summarizationMaxTokensOverride: 128_000,
      },
    });

  beforeEach(() => {
    mockInferenceConfigured.mockReturnValue(false);
    mockFlag.mockResolvedValue(false);
    saveSummary.mockClear();
    recordEvent.mockClear();
    primary = new MockLanguageModelV3({
      modelId: "synthetic-primary",
      doGenerate: async () => summary(),
    });
    fallback = new MockLanguageModelV3({
      modelId: "synthetic-fallback",
      doGenerate: async () => summary(),
    });
    finalFallback = new MockLanguageModelV3({
      modelId: "synthetic-final-fallback",
      doGenerate: async () => summary(),
    });
    models.set("model-glm-5.3-flash", primary);
    models.set("model-deepseek-v4-flash-vision-pro", fallback);
    models.set("model-glm-5.3", finalFallback);
    models.set(
      "model-deepseek-v4.1-flash-1017-pro",
      new MockLanguageModelV3({
        doGenerate: async () => {
          throw new DOMException("Synthetic DeepSeek timeout", "TimeoutError");
        },
      }),
    );
    writer = { write: jest.fn() } as unknown as UIMessageStreamWriter;
  });

  it.each([
    ["free", "agent"],
    ["pro", "agent"],
    ["free", "ask"],
    ["pro", "ask"],
  ] as const)(
    "persists a DeepSeek checkpoint after an Inference error for %s %s",
    async (subscription, mode) => {
      enableInference();
      const inference = new MockLanguageModelV3({
        modelId: "synthetic-inference",
        doGenerate: async () => {
          throw new Error("Synthetic provider failure");
        },
      });
      models.set(INFERENCE, inference);
      const deepSeek = new MockLanguageModelV3({
        modelId: "synthetic-deepseek",
        doGenerate: async () => ({
          ...summary(),
          content: [
            {
              type: "text",
              text: (mode === "agent"
                ? AGENT_SUMMARIZATION_PROMPT
                : ASK_SUMMARIZATION_PROMPT
              )
                .match(/^## .+$/gm)!
                .join("\n(none)\n"),
            },
          ],
        }),
      });
      models.set(DEEPSEEK_1017, deepSeek);
      const result = await checkAndSummarizeIfNeeded({
        uiMessages: messages,
        subscription,
        languageModel: primary,
        mode,
        writer,
        chatId: "synthetic-default-policy",
        startupCompaction: {},
        compactionPolicy: new CompactionModelPolicy({
          userId: "synthetic",
          runId: "synthetic",
          chatId: "synthetic-default-policy",
          subscription,
          mode,
          baselineModel: "agent-model",
          platformAuthorized: false,
          onDiscardedUsage: () => {},
        }),
        providerPromptPressure: {
          reason: "serialized_message_bytes",
          reasons: ["serialized_message_bytes"],
          toolResultCount: 0,
          messageCount: 120,
          summarizationMaxTokensOverride: 128000,
        },
      });
      expect(result.needsSummarization).toBe(true);
      expect(inference.doGenerateCalls).toHaveLength(1);
      expect(inference.doGenerateCalls[0].providerOptions).toEqual({
        inference: { reasoningEffort: "low" },
      });
      expect(deepSeek.doGenerateCalls).toHaveLength(1);
      expect(primary.doGenerateCalls).toHaveLength(0);
      expect(fallback.doGenerateCalls).toHaveLength(0);
      const recoveryProvider =
        deepSeek.doGenerateCalls[0].providerOptions?.openrouter?.provider;
      expect(recoveryProvider).toMatchObject({
        sort: "throughput",
        data_collection: "deny",
      });
      expect(recoveryProvider).not.toHaveProperty("ignore");
      expect(recoveryProvider).not.toHaveProperty("order");
      expect(saveSummary).toHaveBeenCalledTimes(1);
    },
  );

  it("persists one fallback after a recoverable primary failure", async () => {
    let primarySignal: AbortSignal | undefined;
    primary.doGenerate = async ({ abortSignal }) => {
      primarySignal = abortSignal;
      throw new APICallError({
        message: "Synthetic 503",
        url: "https://synthetic.invalid",
        requestBodyValues: {},
        statusCode: 503,
        isRetryable: true,
      });
    };
    const result = await start();
    expect(primarySignal).toBeUndefined();
    expect(result.needsSummarization).toBe(true);
    expect(fallback.doGenerateCalls).toHaveLength(1);
    expect(saveSummary).toHaveBeenCalledTimes(1);
  });
  it.each([
    {
      mode: "ask",
      expandedAgentContext: false,
      inference: true,
      timeout: false,
    },
    {
      mode: "agent",
      expandedAgentContext: false,
      inference: true,
      timeout: false,
    },
    {
      mode: "agent",
      expandedAgentContext: true,
      inference: true,
      timeout: false,
    },
    {
      mode: "agent",
      expandedAgentContext: true,
      inference: true,
      timeout: true,
    },
    {
      mode: "agent",
      expandedAgentContext: true,
      inference: false,
      timeout: false,
    },
  ] as const)(
    "sends enforced JSON and a reasoning-plus-text budget over the $mode adapter (expanded=$expandedAgentContext, inference=$inference, timeout=$timeout)",
    async ({ mode, expandedAgentContext, inference, timeout }) => {
      if (inference) enableInference();
      const large = new MockLanguageModelV3({
        doGenerate: async () => {
          throw timeout
            ? new DOMException("Synthetic Inference timeout", "TimeoutError")
            : new Error("Synthetic Inference provider failure");
        },
      });
      models.set(INFERENCE, large);
      // Inference recovers on DeepSeek first; the beforeEach DeepSeek times out,
      // so ordinary Inference summaries reach structured GLM. Without Inference,
      // expanded summaries start on structured GLM.
      const deepSeekRecovery = inference && expandedAgentContext;
      const recoveryKey = deepSeekRecovery
        ? DEEPSEEK_1017
        : "model-glm-5.3-flash";
      const recoverySlug = deepSeekRecovery
        ? "deepseek/deepseek-v4.1-flash-1017"
        : "z-ai/glm-5.3-flash";
      const EdgeResponse =
        require("next/dist/compiled/@edge-runtime/primitives/fetch").Response;
      const payloads: Record<string, any>[] = [];
      const model = createOpenRouter({
        apiKey: "synthetic-not-a-credential",
        fetch: async (_url, init) => {
          payloads.push(JSON.parse(String(init?.body)));
          return new EdgeResponse(
            JSON.stringify({
              id: "gen-structured-fixture",
              created: 0,
              model: recoverySlug,
              provider: "Fixture",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: jsonCheckpoint(
                      mode,
                      "Scope fixture.test only. Check C pending; session term_17, PID 73142 still running.",
                    ),
                    reasoning: "Do not save private reasoning",
                  },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 9200,
                total_tokens: 9300,
                completion_tokens_details: { reasoning_tokens: 9000 },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      }).chat(recoverySlug);
      models.set(recoveryKey, model);
      const discarded = jest.fn();
      const result = await checkAndSummarizeIfNeeded({
        uiMessages: messages,
        subscription: "pro",
        languageModel: model,
        mode,
        writer,
        chatId: "synthetic-structured-wire",
        compactionPolicy: new CompactionModelPolicy({
          userId: "synthetic",
          runId: "synthetic",
          chatId: "synthetic-structured-wire",
          mode,
          subscription: "pro",
          baselineModel: "agent-model",
          platformAuthorized: false,
          expandedAgentContext,
          onDiscardedUsage: discarded,
        }),
        providerPromptPressure: {
          reason: "serialized_message_bytes",
          reasons: ["serialized_message_bytes"],
          toolResultCount: 0,
          messageCount: 120,
          summarizationMaxTokensOverride: 128000,
        },
      });
      expect(result.needsSummarization).toBe(true);
      expect(result.summaryText).toContain(
        "## Current State\nScope fixture.test only. Check C pending; session term_17, PID 73142 still running.",
      );
      expect(result.summaryText).not.toContain("Do not save private reasoning");
      expect(discarded).not.toHaveBeenCalled();
      expect(saveSummary).toHaveBeenCalledTimes(1);
      expect(payloads).toHaveLength(1);
      expect(large.doGenerateCalls).toHaveLength(inference ? 1 : 0);
      expect(payloads[0]).toMatchObject({
        model: recoverySlug,
        max_tokens: 16384,
        reasoning: { enabled: true, effort: "low" },
        provider: {
          require_parameters: true,
          ...(!deepSeekRecovery && {
            order: ["baseten"],
            ignore: ["modal"],
          }),
          sort: "latency",
          data_collection: "deny",
        },
        response_format: {
          type: "json_schema",
          json_schema: {
            strict: true,
            schema: {
              additionalProperties: false,
              required: expect.arrayContaining([
                "Current State",
                "Relevant Files & Artifacts",
              ]),
            },
          },
        },
      });
      if (deepSeekRecovery) {
        expect(payloads[0].provider).not.toHaveProperty("order");
        expect(payloads[0]).not.toHaveProperty("models");
      }
      expect(recordEvent).toHaveBeenCalledWith(
        "compaction_model_finished",
        expect.objectContaining({
          served_model: recoveryKey,
          attempt_count: deepSeekRecovery ? 2 : inference ? 3 : 1,
        }),
      );
      expect(
        payloads[0].response_format.json_schema.schema.required,
      ).toHaveLength(mode === "agent" ? 10 : 7);
      expect(payloads[0].messages.at(-1).content).toContain(
        "Return only a JSON object",
      );
      if (deepSeekRecovery) {
        large.doGenerate = async () => ({
          ...summary(),
          content: [{ type: "reasoning", text: "Synthetic private reasoning" }],
          usage: {
            ...summary().usage,
            outputTokens: { total: 4460, text: 0, reasoning: 4460 },
          },
        });
        const history = [
          {
            role: "user" as const,
            content:
              "Scope fixture.test only; session term_17, PID 73142 running. ".repeat(
                300,
              ),
          },
        ];
        const original = JSON.stringify(history);
        const rolling = await compactModelMessagesInRun({
          modelMessages: history,
          transcriptModelMessages: history,
          subscription: "pro",
          languageModel: model,
          mode: "agent",
          writer,
          chatId: "synthetic-rolling-wire",
          maxTokens: 484_000,
          compactionIndex: 1,
          hasExistingSummary: true,
          compactionPolicy: new CompactionModelPolicy({
            userId: "synthetic",
            runId: "synthetic",
            chatId: "synthetic-rolling-wire",
            mode: "agent",
            subscription: "pro",
            baselineModel: "agent-model",
            platformAuthorized: false,
            expandedAgentContext: true,
            onDiscardedUsage: discarded,
          }),
        });
        expect(rolling?.summaryText).toContain("PID 73142 still running");
        expect(rolling?.summaryText).not.toContain(
          "Synthetic private reasoning",
        );
        expect(discarded).toHaveBeenCalledTimes(1);
        expect(discarded).toHaveBeenCalledWith(
          expect.objectContaining({ outputTokens: 4460 }),
        );
        expect(JSON.stringify(history)).toBe(original);
        expect(saveSummary).toHaveBeenCalledTimes(1); // Rolling checkpoints stay request-local.
        expect(payloads).toHaveLength(2);
        expect(recordEvent).toHaveBeenCalledWith(
          "compaction_model_finished",
          expect.objectContaining({
            persistence: "run_scoped",
            outcome: "completed",
            fallback_used: true,
          }),
        );
      }
    },
  );

  it.each([
    {
      modelKey: "model-glm-5.3-flash",
      expandedAgentContext: true,
      deadline: 75_000,
      completionMs: 74_000,
    },
    {
      modelKey: "model-glm-5.3-flash",
      expandedAgentContext: true,
      deadline: 75_000,
      completionMs: 76_000,
    },
    {
      modelKey: INFERENCE,
      expandedAgentContext: false,
      deadline: 120_000,
      completionMs: 90_000,
    },
    {
      modelKey: INFERENCE,
      expandedAgentContext: false,
      deadline: 120_000,
      completionMs: 121_000,
    },
    {
      modelKey: INFERENCE,
      expandedAgentContext: true,
      deadline: 120_000,
      completionMs: 119_000,
    },
    {
      modelKey: INFERENCE,
      expandedAgentContext: true,
      deadline: 120_000,
      completionMs: 121_000,
    },
  ])(
    "lets $modelKey finish within $deadline ms and recovers beyond it (expanded=$expandedAgentContext, completion=$completionMs)",
    async ({ modelKey, expandedAgentContext, deadline, completionMs }) => {
      const isGlm = modelKey === "model-glm-5.3-flash";
      jest.useFakeTimers();
      // Node's native AbortSignal.timeout bypasses Jest's clock. Preserve its
      // contract while allowing the real SDK's deadline to advance virtually.
      const timeout = jest
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((ms) => {
          const controller = new AbortController();
          setTimeout(
            () =>
              controller.abort(new DOMException("Timed out", "TimeoutError")),
            ms,
          );
          return controller.signal;
        });
      try {
        if (!isGlm) enableInference();
        const checkpoint = AGENT_SUMMARIZATION_PROMPT.match(/^## .+$/gm)!.join(
          "\nScope fixture.test only; PID 73142 still running.\n",
        );
        const valid = (structured: boolean) => ({
          ...summary(),
          content: [
            {
              type: "text" as const,
              text: structured
                ? jsonCheckpoint(
                    "agent",
                    "Scope fixture.test only; PID 73142 still running.",
                  )
                : checkpoint,
            },
          ],
        });
        const timedModel = new MockLanguageModelV3({
          doGenerate: ({ abortSignal }) =>
            new Promise((resolve, reject) => {
              const timer = setTimeout(
                () => resolve(valid(isGlm)),
                completionMs,
              );
              abortSignal?.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  reject(abortSignal.reason);
                },
                { once: true },
              );
            }),
        });
        const recovery = new MockLanguageModelV3({
          doGenerate: async () => valid(expandedAgentContext),
        });
        models.set(modelKey, timedModel);
        // Both expanded GLM and Inference recover on DeepSeek V4.1 Flash.
        models.set(DEEPSEEK_1017, recovery);
        const pending = checkAndSummarizeIfNeeded({
          uiMessages: messages,
          subscription: "pro",
          languageModel: primary,
          mode: "agent",
          writer,
          chatId: "synthetic-deadline",
          compactionPolicy: new CompactionModelPolicy({
            userId: "synthetic",
            runId: "synthetic",
            chatId: "synthetic-deadline",
            mode: "agent",
            subscription: "pro",
            baselineModel: "agent-model",
            platformAuthorized: false,
            expandedAgentContext,
            onDiscardedUsage: jest.fn(),
          }),
          providerPromptPressure: {
            reason: "serialized_message_bytes",
            reasons: ["serialized_message_bytes"],
            toolResultCount: 0,
            messageCount: 120,
            summarizationMaxTokensOverride: 128000,
          },
        });
        await jest.advanceTimersByTimeAsync(completionMs);
        expect((await pending).summaryText).toContain("73142 still running");
        expect(saveSummary).toHaveBeenCalledTimes(1);
        expect(timedModel.doGenerateCalls).toHaveLength(1);
        expect(recovery.doGenerateCalls).toHaveLength(
          completionMs > deadline ? 1 : 0,
        );
        if (completionMs > deadline) {
          expect(recordEvent).toHaveBeenCalledWith(
            "compaction_model_attempt_finished",
            expect.objectContaining({
              failure_reason: "timeout",
              served_model: modelKey,
              duration_ms: deadline,
            }),
          );
        }
        // Timeouts and successful attempts never carry the structured subtype.
        expect(JSON.stringify(recordEvent.mock.calls)).not.toContain(
          "structured_summary_",
        );
      } finally {
        timeout.mockRestore();
        jest.useRealTimers();
      }
    },
  );

  it.each(
    (
      [
        "reasoning",
        "malformed",
        "array",
        "missing",
        "blank",
        "truncated",
      ] as const
    ).flatMap((kind) =>
      [false, true].map((expandedAgentContext) => ({
        kind,
        expandedAgentContext,
      })),
    ),
  )(
    "rejects $kind output without saving it or losing usage (expanded=$expandedAgentContext)",
    async ({ kind, expandedAgentContext }) => {
      // Structured GLM is the expanded primary without Inference, and the final
      // recovery after Inference and DeepSeek for ordinary Inference summaries.
      const inference = !expandedAgentContext;
      if (inference) enableInference();
      const large = new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error("Synthetic Inference failure");
        },
      });
      models.set(INFERENCE, large);
      const original = JSON.stringify(messages);
      const fields = JSON.parse(
        jsonCheckpoint("agent", "Synthetic private incomplete checkpoint"),
      );
      if (kind === "missing") delete fields["Current State"];
      if (kind === "blank") fields["Current State"] = " ";
      const glm = new MockLanguageModelV3({
        doGenerate: async () => ({
          ...summary(),
          finishReason: {
            unified: kind === "truncated" ? "length" : "stop",
            raw: undefined,
          },
          content:
            kind === "reasoning"
              ? [{ type: "reasoning", text: "Synthetic private reasoning" }]
              : [
                  {
                    type: "text",
                    text:
                      kind === "malformed"
                        ? "{broken"
                        : kind === "array"
                          ? JSON.stringify([fields])
                          : JSON.stringify(fields),
                  },
                ],
          usage: {
            ...summary().usage,
            outputTokens: { total: 20, text: 0, reasoning: 20 },
          },
          providerMetadata: {
            openrouter: {
              provider: "Fixture Provider",
              privateBody: "Never send to analytics",
            },
          },
          response: { id: "gen-fixture", modelId: "fixture-model" },
        }),
      });
      models.set("model-glm-5.3-flash", glm);
      if (!inference)
        models.set(
          DEEPSEEK_1017,
          new MockLanguageModelV3({
            doGenerate: async () => ({
              ...summary(),
              content: [
                {
                  type: "text",
                  text: jsonCheckpoint("agent", "Scope fixture.test."),
                },
              ],
            }),
          }),
        );
      const discarded = jest.fn();
      const result = await checkAndSummarizeIfNeeded({
        uiMessages: messages,
        subscription: "pro",
        languageModel: primary,
        mode: "agent",
        writer,
        chatId: "synthetic-diagnostics",
        compactionPolicy: new CompactionModelPolicy({
          userId: "synthetic",
          runId: "synthetic",
          chatId: "synthetic-diagnostics",
          mode: "agent",
          subscription: "pro",
          baselineModel: "agent-model",
          platformAuthorized: false,
          expandedAgentContext,
          onDiscardedUsage: discarded,
        }),
        providerPromptPressure: {
          reason: "serialized_message_bytes",
          reasons: ["serialized_message_bytes"],
          toolResultCount: 0,
          messageCount: 120,
          summarizationMaxTokensOverride: 128000,
        },
      });
      expect(result.needsSummarization).toBe(!inference);
      expect(discarded).toHaveBeenCalledTimes(1);
      expect(recordEvent).toHaveBeenCalledWith(
        "compaction_model_attempt_finished",
        expect.objectContaining({
          failure_reason:
            kind === "reasoning"
              ? "reasoning_only"
              : kind === "truncated"
                ? "non_stop_finish"
                : "missing_sections",
          upstream_provider: "Fixture Provider",
          generation_id: "gen-fixture",
          finish_reason: kind === "truncated" ? "length" : "stop",
          reasoning_tokens: 20,
        }),
      );
      // Only a stop-finished structured rejection carries the closed subtype;
      // provider failures and successful attempts stay unchanged.
      const subtypes: Partial<Record<typeof kind, string>> = {
        malformed: "invalid_json",
        array: "invalid_object",
        missing: "invalid_sections",
        blank: "invalid_sections",
      };
      const subtype = subtypes[kind];
      const attempts = recordEvent.mock.calls
        .filter(([event]) => event === "compaction_model_attempt_finished")
        .map(([, properties]) => properties as Record<string, unknown>);
      expect(
        attempts.map((properties) => [
          properties.served_model,
          properties.structured_summary_diagnostic_version,
          properties.structured_summary_failure_kind,
        ]),
      ).toEqual([
        ...(inference
          ? [
              [INFERENCE, undefined, undefined],
              [DEEPSEEK_1017, undefined, undefined],
            ]
          : []),
        ["model-glm-5.3-flash", subtype && 1, subtype],
        ...(inference ? [] : [[DEEPSEEK_1017, undefined, undefined]]),
      ]);
      expect(JSON.stringify(recordEvent.mock.calls)).not.toMatch(
        /Synthetic private reasoning|Never send to analytics|Current State/,
      );
      expect(saveSummary).toHaveBeenCalledTimes(inference ? 0 : 1);
      expect(JSON.stringify(messages)).toBe(original);
      expect(large.doGenerateCalls).toHaveLength(inference ? 1 : 0);
      expect(glm.doGenerateCalls).toHaveLength(1);
      expect(JSON.stringify(saveSummary.mock.calls)).not.toContain(
        "Synthetic private",
      );
      if (!inference)
        expect(result.summaryText).toContain("Scope fixture.test.");
    },
  );

  it.each([400, 403, 503])(
    "recovers non-retryable Inference and DeepSeek HTTP %s through GLM",
    async (statusCode) => {
      enableInference();
      const reject = async (): Promise<never> => {
        throw new APICallError({
          message: "Synthetic provider rejection",
          url: "https://synthetic.invalid",
          requestBodyValues: {},
          statusCode,
          isRetryable: false,
        });
      };
      const inference = new MockLanguageModelV3({
        modelId: "synthetic-inference",
        doGenerate: reject,
      });
      const deepSeek = new MockLanguageModelV3({
        modelId: "synthetic-deepseek",
        doGenerate: reject,
      });
      const glm = new MockLanguageModelV3({
        modelId: "synthetic-glm",
        doGenerate: async () => ({
          ...summary(),
          content: [
            {
              type: "text",
              text: jsonCheckpoint(
                "agent",
                "Scope fixture.test only; session 73142 still running; check C pending.",
              ),
            },
          ],
        }),
      });
      models.set(INFERENCE, inference);
      models.set(DEEPSEEK_1017, deepSeek);
      models.set("model-glm-5.3-flash", glm);
      const original = JSON.stringify(messages);
      const discarded = jest.fn();
      const result = await checkAndSummarizeIfNeeded({
        uiMessages: messages,
        subscription: "pro",
        languageModel: primary,
        mode: "agent",
        writer,
        chatId: "synthetic-rejection",
        compactionPolicy: new CompactionModelPolicy({
          userId: "synthetic",
          runId: "synthetic",
          chatId: "synthetic-rejection",
          subscription: "pro",
          mode: "agent",
          baselineModel: "agent-model",
          platformAuthorized: false,
          onDiscardedUsage: discarded,
        }),
        providerPromptPressure: {
          reason: "serialized_message_bytes",
          reasons: ["serialized_message_bytes"],
          toolResultCount: 0,
          messageCount: 120,
          summarizationMaxTokensOverride: 128000,
        },
      });
      expect(result.needsSummarization).toBe(true);
      expect(result.summaryText).toContain(
        "session 73142 still running; check C pending",
      );
      expect(inference.doGenerateCalls).toHaveLength(1);
      expect(deepSeek.doGenerateCalls).toHaveLength(1);
      expect(glm.doGenerateCalls).toHaveLength(1);
      // Structured GLM appends its JSON instruction to the same history.
      expect(glm.doGenerateCalls[0].prompt.slice(0, -1)).toEqual(
        deepSeek.doGenerateCalls[0].prompt.slice(0, -1),
      );
      expect(saveSummary).toHaveBeenCalledTimes(1);
      expect(discarded).not.toHaveBeenCalled(); // The rejected call returned no usage.
      expect(JSON.stringify(messages)).toBe(original);
    },
  );

  it.each(["primary", "fallback"] as const)(
    "cancels during active %s generation without persisting",
    async (attempt) => {
      const controller = new AbortController();
      let entered!: () => void;
      const active = new Promise<void>((resolve) => {
        entered = resolve;
      });
      if (attempt === "fallback") {
        primary.doGenerate = async () => {
          throw new APICallError({
            message: "Synthetic 429",
            url: "https://synthetic.invalid",
            requestBodyValues: {},
            statusCode: 429,
            isRetryable: true,
          });
        };
      }
      const target = attempt === "primary" ? primary : fallback;
      target.doGenerate = async ({ abortSignal }) => {
        entered();
        return new Promise((_resolve, reject) => {
          abortSignal?.addEventListener(
            "abort",
            () => reject(abortSignal.reason),
            { once: true },
          );
        });
      };
      const result = start(controller.signal);
      const rejected = expect(result).rejects.toMatchObject({
        name: "AbortError",
      });
      await active;
      controller.abort();
      await rejected;
      expect(saveSummary).not.toHaveBeenCalled();
      if (attempt === "primary")
        expect(fallback.doGenerateCalls).toHaveLength(0);
      expect(writer.write).not.toHaveBeenCalledWith(
        expect.objectContaining({
          type: "data-summarization",
          data: expect.objectContaining({ status: "completed" }),
        }),
      );
    },
  );
});
