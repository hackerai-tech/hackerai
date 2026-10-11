import { generateText, streamText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { TextDecoderStream, WritableStream } from "node:stream/web";
import { deserialize, serialize } from "node:v8";
import { abliteration } from "../abliteration";
import { UsageTracker } from "@/lib/usage-tracker";
import { generateSummaryText } from "@/lib/chat/summarization/helpers";

jest.mock("@/lib/db/actions", () => ({ logUsageRecord: jest.fn() }));
jest.mock("server-only", () => ({}));

const primitives = require("next/dist/compiled/@edge-runtime/primitives/fetch");
const originalFetch = globalThis.fetch;
const originalHeaders = globalThis.Headers;
const originalResponse = globalThis.Response;
const originalWritableStream = globalThis.WritableStream;
const originalTextDecoderStream = globalThis.TextDecoderStream;
const originalStructuredClone = globalThis.structuredClone;
const fetchMock = jest.fn();

beforeAll(() => {
  globalThis.fetch = fetchMock;
  globalThis.Headers = primitives.Headers;
  globalThis.Response = primitives.Response;
  globalThis.WritableStream = WritableStream;
  globalThis.TextDecoderStream = TextDecoderStream;
  globalThis.structuredClone = (value) => deserialize(serialize(value));
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  globalThis.Headers = originalHeaders;
  globalThis.Response = originalResponse;
  globalThis.WritableStream = originalWritableStream;
  globalThis.TextDecoderStream = originalTextDecoderStream;
  globalThis.structuredClone = originalStructuredClone;
});
beforeEach(() => fetchMock.mockReset());

// Provider-reported completion tokens include reasoning. Cached input is a
// subset of prompt tokens, not extra input to charge a second time.
const wireUsage = {
  prompt_tokens: 1000,
  completion_tokens: 200,
  total_tokens: 1200,
  prompt_tokens_details: { cached_tokens: 800 },
  completion_tokens_details: { reasoning_tokens: 150 },
};

function completion(model: string) {
  return new Response(
    JSON.stringify({
      id: "synthetic-completion",
      created: 1,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Synthetic answer" },
          finish_reason: "stop",
        },
      ],
      usage: wireUsage,
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function streamedCompletion(model: string) {
  const chunks = [
    {
      id: "synthetic-stream",
      created: 1,
      model,
      choices: [
        {
          index: 0,
          delta: { content: "Synthetic answer" },
          finish_reason: null,
        },
      ],
    },
    {
      id: "synthetic-stream",
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    // Usage arrives after the finish-reason chunk, as on the wire.
    {
      id: "synthetic-stream",
      created: 1,
      model,
      choices: [],
      usage: wireUsage,
    },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe.each([
  ["abliterated-model", 0.00088],
  ["abliterated-model-large-v2", 0.00184],
] as const)("%s usage accounting through the installed SDK", (model, cost) => {
  it.each([false, true])(
    "counts input, cache reads, and reasoning once (stream=%s)",
    async (stream) => {
      fetchMock.mockResolvedValueOnce(
        stream ? streamedCompletion(model) : completion(model),
      );
      const tracker = new UsageTracker();
      const options = {
        model: abliteration(model),
        prompt: "Synthetic request",
      };
      const result = stream ? streamText(options) : await generateText(options);
      const usage = await result.usage;
      expect(await result.text).toBe("Synthetic answer");
      expect(usage).toMatchObject({
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        inputTokenDetails: { cacheReadTokens: 800 },
        outputTokenDetails: { textTokens: 50, reasoningTokens: 150 },
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBe(model);
      if (stream) expect(body.stream_options).toEqual({ include_usage: true });
      tracker.accumulateStep(usage, model);
      expect(tracker.totalTokens).toBe(1200);
      expect(tracker.computeModelCostDollars(model)).toBeCloseTo(cost, 8);
    },
  );

  it("adds direct model and compaction cost to authoritative OpenRouter cost", async () => {
    fetchMock.mockResolvedValueOnce(streamedCompletion(model));
    const tracker = new UsageTracker();
    const direct = streamText({
      model: abliteration(model),
      prompt: "Synthetic request",
      onStepFinish: ({ usage, response }) => {
        tracker.accumulateStep(usage, response.modelId);
      },
    });
    await direct.consumeStream();

    fetchMock.mockResolvedValueOnce(completion(model));
    const summary = await generateSummaryText(
      [],
      abliteration(model),
      "ask",
      "Synthetic system prompt",
      false,
    );
    expect(summary.usage).toMatchObject({
      inputTokens: 1000,
      inputTokensReported: true,
      outputTokens: 200,
      cacheReadTokens: 800,
      model,
    });
    tracker.accumulateSummarization(summary.usage);

    const openRouter = createOpenRouter({ apiKey: "synthetic-test-key" });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "gen-synthetic",
          created: 1,
          model: "deepseek/deepseek-v4.1-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Continuation" },
              finish_reason: "stop",
            },
          ],
          usage: {
            ...wireUsage,
            cost: 0,
            cost_details: { upstream_inference_cost: 0.002 },
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const continuation = await generateText({
      model: openRouter("deepseek/deepseek-v4.1-flash"),
      prompt: "Synthetic continuation request",
    });
    tracker.accumulateStep(continuation.usage, continuation.response.modelId);
    tracker.nonModelCost = 0.001;

    const record = tracker.createUsageCostRecord({
      selectedModel: "agent-model",
      configuredModelId: model,
      rateLimitInfo: { remaining: 1000, limit: 1000, resetTime: new Date() },
    });
    expect(record).toMatchObject({
      inputTokens: 3000,
      outputTokens: 600,
      totalTokens: 3600,
      cacheReadTokens: 2400,
      costSource: "hybrid",
    });
    expect(record.modelCostDollars).toBeCloseTo(cost * 2 + 0.002, 8);
    expect(record.costDollars).toBeCloseTo(cost * 2 + 0.003, 8);
    expect(tracker.providerCost).toBeCloseTo(0.002, 8);
  });
});
