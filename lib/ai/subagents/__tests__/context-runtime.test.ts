/**
 * @jest-environment node
 */
import { MockLanguageModelV3 } from "ai/test";
import {
  Output,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type UIMessageStreamWriter,
} from "ai";
import { z } from "zod";
import { getCompactionSections } from "@/lib/chat/summarization/structured-summary";
import { UsageTracker } from "@/lib/usage-tracker";
import {
  createSubagentModelContext,
  SubagentContextBudgetError,
  type SubagentModelContext,
} from "../context";

// Exercise the installed AI SDK step loop and the shared compaction engine.
// Only provider models, analytics and persistence are replaced at their boundary.
jest.mock("server-only", () => ({}));
const mockChatSummaryWrite = jest.fn();
jest.mock("@/lib/db/actions", () => ({
  logUsageRecord: jest.fn(),
  saveChatSummary: (...args: unknown[]) => mockChatSummaryWrite(...args),
  attachChatSummaryTranscript: (...args: unknown[]) =>
    mockChatSummaryWrite(...args),
}));
jest.mock("@/lib/posthog/server", () => ({
  getPostHogBooleanFlagDecisionForUser: async () => false,
  phLogger: { event: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock("@/lib/ai/abliteration", () => ({
  ...jest.requireActual("@/lib/ai/abliteration"),
  isAbliterationConfigured: () => false,
}));
jest.mock("@/lib/ai/inference", () => ({
  ...jest.requireActual("@/lib/ai/inference"),
  isInferenceConfigured: () => false,
}));
const mockSummaryModels = new Map<string, LanguageModel>();
jest.mock("@/lib/ai/providers", () => ({
  KIMI_K3_SLUG: "moonshotai/kimi-k3",
  myProvider: {
    languageModel: (name: string) => {
      const model = mockSummaryModels.get(name);
      if (!model) throw new Error(`Unexpected summary model ${name}`);
      return model;
    },
  },
}));

const SYSTEM = "You are a bounded HackerAI worker.";
const PRIMARY_SUMMARY_MODEL = "model-glm-5.3-flash";
const FALLBACK_SUMMARY_MODEL = "model-deepseek-v4-flash-vision-pro";
// Well above the 256k threshold and 276k budget after tokenization.
const OVERSIZED = "evidence ".repeat(290_000);

const user = (content: string): ModelMessage => ({ role: "user", content });
const toolPair = (id: string, output: string): ModelMessage[] => [
  {
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: id, toolName: "lookup", input: {} },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "lookup",
        output: { type: "text", value: output },
      },
    ],
  },
];
const structuredSummary = (marker: string) =>
  getCompactionSections("agent")
    .map((section) => `## ${section}\n${marker}`)
    .join("\n\n");
const summaryModel = (text: string, usage: { input: number; output: number }) =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: {
        inputTokens: {
          total: usage.input,
          noCache: usage.input,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: usage.output,
          text: usage.output,
          reasoning: undefined,
        },
      },
      warnings: [],
    }),
  });

type Turn = "tool" | "text" | "json" | Error;
const scriptedModel = (turns: Turn[]) => {
  const prompts: string[] = [];
  const calls: Array<{ tools?: unknown[]; responseFormat?: unknown }> = [];
  let index = 0;
  const model: LanguageModel = {
    specificationVersion: "v3",
    provider: "test",
    modelId: "deepseek/deepseek-v4-flash",
    supportedUrls: {},
    doGenerate: jest.fn(),
    doStream: async ({ prompt, tools: requestTools, responseFormat }) => {
      prompts.push(JSON.stringify(prompt));
      calls.push({ tools: requestTools, responseFormat });
      const turn = turns[index++] ?? "text";
      if (turn instanceof Error) throw turn;
      return {
        stream: new ReadableStream({
          start(controller) {
            if (turn === "tool") {
              controller.enqueue({
                type: "tool-call",
                toolCallId: `fresh-${index}`,
                toolName: "lookup",
                input: "{}",
              });
            } else {
              controller.enqueue({ type: "text-start", id: "t" });
              controller.enqueue({
                type: "text-delta",
                id: "t",
                delta:
                  turn === "json"
                    ? JSON.stringify({ summary: "RECOVERED-RESULT" })
                    : "Submitting.",
              });
              controller.enqueue({ type: "text-end", id: "t" });
            }
            controller.enqueue({
              type: "finish",
              finishReason: {
                unified: turn === "tool" ? "tool-calls" : "stop",
                raw: turn === "tool" ? "tool-calls" : "stop",
              },
              usage: {
                inputTokens: {
                  total: 4_000,
                  noCache: 4_000,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 20, text: 20, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      };
    },
  };
  return { model, prompts, calls };
};

const resultSchema = z.object({ summary: z.string() });
const TOOL_RESULT_REMINDER = "submit it only by calling submit_task_result";
const STRUCTURED_RESULT_REMINDER = "No tools are available for this request";
const tools = {
  lookup: tool({
    description: "Look up one record",
    inputSchema: z.object({}),
    execute: async () => "FRESH-LOOKUP-RESULT",
  }),
};

const createHarness = ({
  history,
  pinned,
  abortSignal = new AbortController().signal,
}: {
  history: ModelMessage[];
  pinned: ModelMessage[];
  abortSignal?: AbortSignal;
}) => {
  const usageTracker = new UsageTracker();
  const writes: unknown[] = [];
  const writer = {
    write: (chunk: unknown) => writes.push(chunk),
    merge: jest.fn(),
    onError: undefined,
  } as unknown as UIMessageStreamWriter;
  const context = createSubagentModelContext({
    history,
    pinnedMessages: pinned,
    finalResultToolName: "submit_task_result",
    userId: "user_test",
    chatId: "chat-test",
    triggerRunId: "run_child",
    subscription: "pro",
    baselineModel: FALLBACK_SUMMARY_MODEL,
    systemPrompt: SYSTEM,
    writer,
    abortSignal,
    usageTracker,
  });
  return { context, usageTracker, writes };
};

// Mirrors one subagent generation attempt: snapshot, per-step preparation,
// step accounting, then committing responses (or completed steps on failure).
const runAttempt = async (
  context: SubagentModelContext,
  model: LanguageModel,
  {
    abortSignal,
    onPrepare,
    structuredResult = false,
  }: {
    abortSignal?: AbortSignal;
    onPrepare?: (stepNumber: number) => void;
    /** Tool-less recovery that must answer with the result schema. */
    structuredResult?: boolean;
  } = {},
) => {
  let error: unknown;
  const afterCompaction = jest.fn(async () => {});
  const requestTools = structuredResult ? undefined : tools;
  const generation = streamText({
    model,
    system: SYSTEM,
    messages: context.beginAttempt(),
    tools: requestTools,
    output: structuredResult
      ? Output.object({ schema: resultSchema })
      : undefined,
    maxRetries: 0,
    abortSignal,
    stopWhen: stepCountIs(4),
    prepareStep: async ({ messages, stepNumber }) => {
      onPrepare?.(stepNumber);
      return {
        messages: await context.prepareStep({
          rawMessages: messages,
          languageModel: model,
          modelId: (model as { modelId: string }).modelId,
          system: SYSTEM,
          tools: requestTools,
          getHandoffNotes: async () => [
            { id: "note-1", text: "PRIVATE-HANDOFF-NOTE" },
          ],
          afterCompaction,
        }),
      };
    },
    onError: ({ error: streamError }) => {
      error ??= streamError;
    },
    onStepFinish: ({ usage, response }) =>
      context.recordStep({
        inputTokens: usage.inputTokens,
        responseMessages: response.messages,
        thresholdTokens: 256_000,
      }),
  });
  await generation.consumeStream();
  try {
    context.finishAttempt({
      responseMessages: (await generation.response).messages,
    });
  } catch (responseError) {
    error ??= responseError;
    context.finishAttempt({ partialMessages: [] });
  }
  const output = structuredResult
    ? await Promise.resolve(generation.output).catch((outputError: unknown) => {
        error ??= outputError;
        return undefined;
      })
    : undefined;
  return { error, afterCompaction, output };
};

const occurrences = (text: string, marker: string) =>
  text.split(marker).length - 1;

beforeEach(() => {
  mockSummaryModels.clear();
});

describe("subagent model context at the SDK boundary", () => {
  it("does not summarize a request below the Agent threshold", async () => {
    const summary = summaryModel(structuredSummary("UNUSED"), {
      input: 1,
      output: 1,
    });
    mockSummaryModels.set(PRIMARY_SUMMARY_MODEL, summary);
    const objective = user("OBJECTIVE: inspect staging only");
    const { context, usageTracker } = createHarness({
      history: [objective],
      pinned: [objective],
    });
    const { model, prompts } = scriptedModel(["text"]);

    const { error } = await runAttempt(context, model);

    expect(error).toBeUndefined();
    expect(summary.doGenerateCalls).toHaveLength(0);
    expect(prompts).toHaveLength(1);
    expect(occurrences(prompts[0], "OBJECTIVE: inspect staging only")).toBe(1);
    expect(prompts[0]).toContain("PRIVATE-HANDOFF-NOTE");
    expect(usageTracker.summarizationInputTokens).toBe(0);
  });

  it("compacts resumed history before the first request and keeps the checkpoint across steps and a retry", async () => {
    // The primary returns an unusable checkpoint; its discarded usage and the
    // accepted fallback must both be billed exactly once.
    const invalid = summaryModel("Plain prose without required sections.", {
      input: 500,
      output: 50,
    });
    const accepted = summaryModel(structuredSummary("SUMMARY-CHECKPOINT"), {
      input: 1_000,
      output: 100,
    });
    mockSummaryModels.set(PRIMARY_SUMMARY_MODEL, invalid);
    mockSummaryModels.set(FALLBACK_SUMMARY_MODEL, accepted);
    const objective = user("ORIGINAL-OBJECTIVE: inspect staging.example.test");
    const followUp = user("FOLLOW-UP: confirm the admin finding");
    // A retained tail may keep a bounded head/tail preview of an old output;
    // the middle marker proves the raw output itself is not replayed.
    const history = [
      objective,
      ...toolPair(
        "old-scan",
        `${OVERSIZED.slice(0, OVERSIZED.length / 2)}RAW-OLD-OUTPUT${OVERSIZED.slice(OVERSIZED.length / 2)}`,
      ),
      { role: "assistant", content: "Old scan finished." } as ModelMessage,
      ...toolPair("recent-scan", "RECENT-TOOL-RESULT"),
      followUp,
    ];
    const { context, usageTracker, writes } = createHarness({
      history,
      pinned: [objective, followUp],
    });

    const first = scriptedModel(["tool", new Error("provider overloaded")]);
    const firstAttempt = await runAttempt(context, first.model, {
      onPrepare: (stepNumber) => {
        // One update arrives before the compacting request, one after it.
        context.inject(
          user(
            stepNumber === 0
              ? "EARLY-UPDATE: staging uses SSO"
              : "PARENT-UPDATE: also check /admin",
          ),
        );
      },
    });

    expect(firstAttempt.error).toMatchObject({
      message: "provider overloaded",
    });
    expect(invalid.doGenerateCalls).toHaveLength(1);
    expect(accepted.doGenerateCalls).toHaveLength(1);
    expect(firstAttempt.afterCompaction).toHaveBeenCalledTimes(1);
    expect(first.prompts).toHaveLength(2);
    const [initialRequest, nextStepRequest] = first.prompts;
    for (const request of [initialRequest, nextStepRequest]) {
      expect(request).not.toContain("RAW-OLD-OUTPUT");
      expect(request.length).toBeLessThan(200_000);
      expect(occurrences(request, "SUMMARY-CHECKPOINT")).toBeGreaterThan(0);
      expect(occurrences(request, "ORIGINAL-OBJECTIVE")).toBe(1);
      expect(occurrences(request, "FOLLOW-UP: confirm")).toBe(1);
      expect(occurrences(request, "PRIVATE-HANDOFF-NOTE")).toBe(1);
      expect(occurrences(request, "EARLY-UPDATE")).toBe(1);
      expect(request).toContain("submit_task_result");
    }
    // The complete recent tool pair survives with the summary.
    expect(initialRequest).toContain('"toolCallId":"recent-scan"');
    expect(initialRequest).toContain("RECENT-TOOL-RESULT");
    // The next step adds only newer SDK messages and the live parent update.
    expect(nextStepRequest).toContain("FRESH-LOOKUP-RESULT");
    expect(occurrences(nextStepRequest, "PARENT-UPDATE")).toBe(1);

    const retry = scriptedModel(["text"]);
    const retryAttempt = await runAttempt(context, retry.model);

    expect(retryAttempt.error).toBeUndefined();
    expect(retryAttempt.afterCompaction).not.toHaveBeenCalled();
    const [retryRequest] = retry.prompts;
    expect(retryRequest).not.toContain("RAW-OLD-OUTPUT");
    expect(retryRequest.length).toBeLessThan(200_000);
    expect(retryRequest).toContain("SUMMARY-CHECKPOINT");
    expect(occurrences(retryRequest, "FRESH-LOOKUP-RESULT")).toBe(1);
    expect(occurrences(retryRequest, "PARENT-UPDATE")).toBe(1);
    expect(occurrences(retryRequest, "EARLY-UPDATE")).toBe(1);
    expect(occurrences(retryRequest, "ORIGINAL-OBJECTIVE")).toBe(1);
    expect(accepted.doGenerateCalls).toHaveLength(1);

    expect(usageTracker.summarizationInputTokens).toBe(1_500);
    expect(usageTracker.summarizationOutputTokens).toBe(150);
    expect(mockChatSummaryWrite).not.toHaveBeenCalled();
    expect(writes).toContainEqual(
      expect.objectContaining({
        type: "data-summarization",
        data: expect.objectContaining({ status: "completed" }),
      }),
    );
  });

  it("compacts tool-less structured recovery with a schema request, never the unavailable result tool", async () => {
    const summary = summaryModel(structuredSummary("SUMMARY-CHECKPOINT"), {
      input: 900,
      output: 90,
    });
    mockSummaryModels.set(PRIMARY_SUMMARY_MODEL, summary);
    const objective = user("OBJECTIVE: report staging findings");
    const { context } = createHarness({
      history: [objective, ...toolPair("big", OVERSIZED)],
      pinned: [objective],
    });
    const { model, prompts, calls } = scriptedModel(["json"]);

    const { error, output } = await runAttempt(context, model, {
      structuredResult: true,
    });

    expect(error).toBeUndefined();
    expect(summary.doGenerateCalls).toHaveLength(1);
    expect(output).toEqual({ summary: "RECOVERED-RESULT" });
    const [request] = prompts;
    expect(request).toContain("SUMMARY-CHECKPOINT");
    expect(occurrences(request, STRUCTURED_RESULT_REMINDER)).toBe(1);
    expect(request).not.toContain(TOOL_RESULT_REMINDER);
    expect(request).not.toContain("call the next required tool");
    // The request offers no tools and asks for the supplied result schema.
    expect(calls[0].tools ?? []).toHaveLength(0);
    expect(calls[0].responseFormat).toMatchObject({
      type: "json",
      schema: expect.objectContaining({
        properties: expect.objectContaining({ summary: expect.anything() }),
      }),
    });
  });

  it("switches a tool-mode checkpoint to the structured-result continuation for recovery", async () => {
    const summary = summaryModel(structuredSummary("SUMMARY-CHECKPOINT"), {
      input: 900,
      output: 90,
    });
    mockSummaryModels.set(PRIMARY_SUMMARY_MODEL, summary);
    const objective = user("OBJECTIVE: report staging findings");
    const { context } = createHarness({
      history: [objective, ...toolPair("big", OVERSIZED)],
      pinned: [objective],
    });

    // The tool-enabled attempt compacts, then ends without submitting.
    const toolAttempt = scriptedModel(["text"]);
    expect(
      (await runAttempt(context, toolAttempt.model)).error,
    ).toBeUndefined();
    expect(summary.doGenerateCalls).toHaveLength(1);
    expect(occurrences(toolAttempt.prompts[0], TOOL_RESULT_REMINDER)).toBe(1);
    expect(toolAttempt.prompts[0]).not.toContain(STRUCTURED_RESULT_REMINDER);

    const recovery = scriptedModel(["json"]);
    const { error, output } = await runAttempt(context, recovery.model, {
      structuredResult: true,
    });

    expect(error).toBeUndefined();
    expect(output).toEqual({ summary: "RECOVERED-RESULT" });
    expect(summary.doGenerateCalls).toHaveLength(1);
    const [request] = recovery.prompts;
    expect(request).toContain("SUMMARY-CHECKPOINT");
    expect(request.length).toBeLessThan(200_000);
    expect(occurrences(request, STRUCTURED_RESULT_REMINDER)).toBe(1);
    expect(request).not.toContain(TOOL_RESULT_REMINDER);
    expect(request).not.toContain("call the next required tool");
    expect(recovery.calls[0].tools ?? []).toHaveLength(0);
    expect(recovery.calls[0].responseFormat).toMatchObject({ type: "json" });
  });

  it("bounds failing summaries and never sends the oversized request", async () => {
    const failing = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("summary provider down");
      },
    });
    mockSummaryModels.set(PRIMARY_SUMMARY_MODEL, failing);
    const objective = user("OBJECTIVE");
    const { context, usageTracker } = createHarness({
      history: [objective, ...toolPair("big", OVERSIZED)],
      pinned: [objective],
    });
    const { model, prompts } = scriptedModel(["text", "text", "text"]);

    const errors: unknown[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      errors.push((await runAttempt(context, model)).error);
    }

    expect(errors.every((e) => e instanceof SubagentContextBudgetError)).toBe(
      true,
    );
    // Two unproductive compactions are allowed; the third attempt fails closed.
    expect(failing.doGenerateCalls).toHaveLength(2);
    expect(prompts).toHaveLength(0);
    expect(usageTracker.summarizationInputTokens).toBe(0);
  });

  it("bills an ineffective summary once and refuses a still-oversized request", async () => {
    const summary = summaryModel(structuredSummary("SMALL"), {
      input: 700,
      output: 70,
    });
    mockSummaryModels.set(PRIMARY_SUMMARY_MODEL, summary);
    // A verbatim objective cannot be summarized away.
    const objective = user(`OBJECTIVE ${OVERSIZED}`);
    const { context, usageTracker } = createHarness({
      history: [objective, ...toolPair("small", "small result")],
      pinned: [objective],
    });
    const { model, prompts } = scriptedModel(["text"]);

    const { error } = await runAttempt(context, model);

    expect(error).toBeInstanceOf(SubagentContextBudgetError);
    expect(summary.doGenerateCalls).toHaveLength(1);
    expect(usageTracker.summarizationInputTokens).toBe(700);
    expect(usageTracker.summarizationOutputTokens).toBe(70);
    expect(prompts).toHaveLength(0);
  });

  it("propagates cancellation during summary generation without a provider request", async () => {
    const controller = new AbortController();
    const summary = new MockLanguageModelV3({
      doGenerate: ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal?.addEventListener(
            "abort",
            () => reject(abortSignal.reason),
            { once: true },
          );
          controller.abort(new Error("parent canceled"));
        }),
    });
    mockSummaryModels.set(PRIMARY_SUMMARY_MODEL, summary);
    const fallback = summaryModel(structuredSummary("UNUSED"), {
      input: 1,
      output: 1,
    });
    mockSummaryModels.set(FALLBACK_SUMMARY_MODEL, fallback);
    const objective = user("OBJECTIVE");
    const { context, usageTracker } = createHarness({
      history: [objective, ...toolPair("big", OVERSIZED)],
      pinned: [objective],
      abortSignal: controller.signal,
    });
    const { model, prompts } = scriptedModel(["text"]);

    const { error } = await runAttempt(context, model, {
      abortSignal: controller.signal,
    });

    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(SubagentContextBudgetError);
    expect(summary.doGenerateCalls).toHaveLength(1);
    expect(fallback.doGenerateCalls).toHaveLength(0);
    expect(prompts).toHaveLength(0);
    expect(usageTracker.summarizationInputTokens).toBe(0);
  });
});
