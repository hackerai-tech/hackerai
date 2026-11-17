/**
 * @jest-environment node
 */
import { streamText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { UsageTracker } from "../usage-tracker";
import { generateSummaryText } from "@/lib/chat/summarization/helpers";

jest.mock("@/lib/db/actions", () => ({ logUsageRecord: jest.fn() }));
jest.mock("server-only", () => ({}));

// Recognized Opus pricing: $5/M input, $0.50/M cache reads, $6.25/M writes.
const OPUS = "anthropic/claude-4.6-opus-20260205";
const rateLimitInfo = { remaining: 1000, limit: 1000, resetTime: new Date() };

type WireUsage = Record<string, unknown>;

/** OpenRouter chat-completions SSE, with usage after the finish chunk. */
const sseResponse = (model: string, usage: WireUsage) => {
  const chunks = [
    {
      id: "gen-synthetic",
      created: 1,
      model,
      choices: [
        { index: 0, delta: { content: "Answer" }, finish_reason: null },
      ],
    },
    {
      id: "gen-synthetic",
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    { id: "gen-synthetic", created: 1, model, choices: [], usage },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
};

const jsonResponse = (model: string, usage: WireUsage) =>
  new Response(
    JSON.stringify({
      id: "gen-synthetic-summary",
      created: 1,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Summary" },
          finish_reason: "stop",
        },
      ],
      usage,
    }),
    { headers: { "content-type": "application/json" } },
  );

const openRouterWith = (response: () => Response) => {
  const fetch = jest.fn(async () => response());
  return { fetch, provider: createOpenRouter({ apiKey: "synthetic", fetch }) };
};

/** Streams one model step and records it exactly as the stream runner does. */
const streamStep = async (
  tracker: UsageTracker,
  usage: WireUsage,
  model = OPUS,
): Promise<number | undefined> => {
  const { fetch, provider } = openRouterWith(() => sseResponse(model, usage));
  let stepIndex: number | undefined;
  const result = streamText({
    model: provider(model),
    prompt: "Synthetic request",
    onStepFinish: ({ usage: stepUsage }) => {
      stepIndex = tracker.accumulateStep(stepUsage, model);
    },
  });
  await result.consumeStream();
  expect(fetch).toHaveBeenCalledTimes(1);
  return stepIndex;
};

const record = (tracker: UsageTracker) =>
  tracker.createUsageCostRecord({
    selectedModel: OPUS,
    selectedModelOverride: OPUS,
    configuredModelId: OPUS,
    rateLimitInfo,
  });

const wire = (
  promptTokens: number,
  completionTokens: number,
  extra: WireUsage = {},
): WireUsage => ({
  prompt_tokens: promptTokens,
  completion_tokens: completionTokens,
  total_tokens: promptTokens + completionTokens,
  ...extra,
});

describe("provider token receipts through the installed OpenRouter SDK", () => {
  it("keeps earlier usage and provider cost when later receipts are negative or fractional", async () => {
    const tracker = new UsageTracker();
    await streamStep(tracker, wire(10, 2, { cost: 0.001 }));
    await streamStep(tracker, wire(-5, 2, { cost: 0.002 }));
    await streamStep(tracker, wire(1.5, 2, { cost: 0.004 }));

    // The malformed input is ignored; valid output and money still count.
    expect(tracker.lastStepInputTokens).toBe(0);
    expect(record(tracker)).toMatchObject({
      inputTokens: 10,
      outputTokens: 6,
      // 12 reported, then each malformed total falls back to valid output.
      totalTokens: 16,
      costSource: "provider",
    });
    expect(record(tracker).modelCostDollars).toBeCloseTo(0.007, 10);
    expect(tracker.measurementProperties(OPUS)).toMatchObject({
      usage_model_records: 3,
      usage_input_reported_records: 1,
      usage_cache_read_reported_records: 1,
      usage_provider_cost_records: 3,
      usage_unreported_model_records: 0,
      usage_observed_input_tokens: 10,
      usage_cache_covered_input_tokens: 10,
    });
  });

  it("does not let a malformed receipt without cost look like a reported free call", async () => {
    const tracker = new UsageTracker();
    await streamStep(tracker, wire(1.5, 0));

    expect(tracker.hasUsage).toBe(false);
    expect(tracker.hasCacheData).toBe(false);
    expect(tracker.measurementProperties(OPUS)).toMatchObject({
      usage_model_records: 1,
      usage_input_reported_records: 0,
      // The SDK normalizes missing cache details to zero; that zero is not
      // coverage when the input it belongs to is malformed.
      usage_cache_read_reported_records: 0,
      usage_unreported_model_records: 1,
    });
  });

  it("prices input at full rate when the cache read exceeds reported input", async () => {
    const tracker = new UsageTracker();
    await streamStep(
      tracker,
      wire(100_000, 0, { prompt_tokens_details: { cached_tokens: 200_000 } }),
    );

    // 100k uncached Opus input at $5/M, instead of a $0.05 cache-read price.
    expect(record(tracker)).toMatchObject({
      inputTokens: 100_000,
      cacheReadTokens: undefined,
      costSource: "raw_token_estimate",
    });
    expect(record(tracker).modelCostDollars).toBeCloseTo(0.5, 10);
    expect(tracker.hasCacheData).toBe(false);
    expect(tracker.cacheHitRate).toBeNull();
    expect(tracker.measurementProperties(OPUS)).toMatchObject({
      usage_input_reported_records: 1,
      usage_cache_read_reported_records: 0,
      usage_observed_cache_read_tokens: 0,
      usage_observed_model_cost_dollars: expect.closeTo(0.5, 10),
    });
  });

  it.each([
    // [cached, written, recorded read, recorded write, expected cost]
    // 10k uncached ($0.05) + 80k reads ($0.04) + 10k writes ($0.0625).
    ["bounded reads and writes", 80_000, 10_000, 80_000, 10_000, 0.1525],
    // An oversized write is ignored; the valid read still earns its discount.
    [
      "valid reads with oversized writes",
      80_000,
      200_000,
      80_000,
      undefined,
      0.14,
    ],
    // An oversized read is ignored; the valid write keeps its own rate.
    [
      "oversized reads with valid writes",
      200_000,
      10_000,
      undefined,
      10_000,
      0.5125,
    ],
  ])(
    "discounts only bounded cache counts: %s",
    async (_label, cached, written, recordedRead, recordedWrite, cost) => {
      const tracker = new UsageTracker();
      await streamStep(
        tracker,
        wire(100_000, 0, {
          prompt_tokens_details: {
            cached_tokens: cached,
            cache_write_tokens: written,
          },
        }),
      );

      expect(record(tracker)).toMatchObject({
        cacheReadTokens: recordedRead,
        cacheWriteTokens: recordedWrite,
      });
      expect(record(tracker).modelCostDollars).toBeCloseTo(cost, 10);
      expect(tracker.hasCacheData).toBe(true);
    },
  );

  it("keeps explicit zero cache reads as covered telemetry", async () => {
    const tracker = new UsageTracker();
    await streamStep(
      tracker,
      wire(100, 1, { prompt_tokens_details: { cached_tokens: 0 } }),
    );

    expect(tracker.cacheHitRate).toBe(0);
    expect(tracker.measurementProperties(OPUS)).toMatchObject({
      usage_cache_read_reported_records: 1,
      usage_cache_covered_input_tokens: 100,
      usage_cache_covered_read_tokens: 0,
    });
  });

  it("keeps BYOK and late authoritative costs for receipts with malformed tokens", async () => {
    const tracker = new UsageTracker();
    await streamStep(
      tracker,
      wire(-1, 1.5, {
        cost: 0,
        is_byok: true,
        cost_details: { upstream_inference_cost: 0.003 },
      }),
    );
    const lateIndex = await streamStep(tracker, wire(2.5, 1, { cost: 0 }));
    tracker.setAuthoritativeModelCostForStep(lateIndex, 0.0004);

    expect(record(tracker)).toMatchObject({
      inputTokens: 0,
      outputTokens: 1,
      costSource: "provider",
    });
    expect(record(tracker).modelCostDollars).toBeCloseTo(0.0034, 10);
    expect(tracker.measurementProperties(OPUS)).toMatchObject({
      usage_input_reported_records: 0,
      usage_provider_cost_records: 2,
      usage_observed_model_cost_dollars: expect.closeTo(0.0034, 10),
    });
  });

  it("keeps summary usage and discards only the failed model leg on retry", async () => {
    const tracker = new UsageTracker();
    const { provider } = openRouterWith(() =>
      jsonResponse(
        OPUS,
        wire(1.5, 40, {
          prompt_tokens_details: { cached_tokens: 0 },
          cost: 0.01,
        }),
      ),
    );
    const summary = await generateSummaryText(
      [],
      provider(OPUS),
      "ask",
      "Synthetic system prompt",
      false,
    );
    tracker.accumulateSummarization(summary.usage);

    tracker.recordModelCall();
    await streamStep(tracker, wire(1_000, 100, { cost: 0.2 }));
    tracker.prepareModelRetry();
    tracker.recordModelCall();
    await streamStep(tracker, wire(-50, 10, { cost: 0.05 }));

    expect(record(tracker)).toMatchObject({
      inputTokens: 0,
      outputTokens: 50,
      totalTokens: 50,
      cacheReadTokens: undefined,
      costSource: "provider",
    });
    expect(record(tracker).modelCostDollars).toBeCloseTo(0.06, 10);
    expect(tracker.measurementProperties(OPUS)).toMatchObject({
      usage_model_calls_started: 2,
      usage_model_records: 2,
      usage_summary_records: 1,
      usage_retry_resets: 1,
      usage_input_reported_records: 1,
      usage_cache_read_reported_records: 1,
      usage_discarded_retry_cost_dollars: 0.2,
      usage_summary_cost_dollars: 0.01,
      usage_observed_input_tokens: 1_000,
      usage_observed_model_cost_dollars: expect.closeTo(0.26, 10),
    });
  });
});
