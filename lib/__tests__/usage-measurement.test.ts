jest.mock("@/lib/db/actions", () => ({ logUsageRecord: jest.fn() }));
import { UsageTracker } from "../usage-tracker";

it("preserves an explicit zero provider cost instead of labelling it missing", () => {
  const tracker = new UsageTracker();
  tracker.accumulateStep({ inputTokens: 10, raw: { cost: 0 } }, "model");
  expect(tracker.measurementProperties("model")).toMatchObject({
    usage_provider_cost_records: 1,
    usage_observed_model_cost_dollars: 0,
  });
});

it("does not count normalized summary input as reported provider usage", () => {
  const tracker = new UsageTracker();
  tracker.accumulateSummarization({
    inputTokens: 0,
    outputTokens: 0,
    inputTokensReported: false,
    cacheReadTokens: 0,
  });
  tracker.accumulateSummarization({
    inputTokens: 0,
    outputTokens: 0,
    inputTokensReported: true,
    cacheReadTokens: 0,
    cost: 0,
  });
  expect(tracker.measurementProperties("model")).toMatchObject({
    usage_summary_records: 2,
    usage_input_reported_records: 1,
    usage_cache_read_reported_records: 1,
    usage_provider_cost_records: 1,
  });
});

it("retains observed retry costs without adding them back to customer billing", () => {
  const tracker = new UsageTracker();
  tracker.recordModelCall();
  const first = tracker.accumulateStep(
    {
      inputTokens: 100,
      outputTokens: 10,
      inputTokenDetails: { cacheReadTokens: 0 },
      raw: { cost: 2 },
    },
    "model",
  );
  tracker.setAuthoritativeModelCostForStep(first, 2.5);
  tracker.accumulateSummarization({
    inputTokens: 50,
    outputTokens: 5,
    cacheReadTokens: 25,
    cost: 1,
    model: "model",
  });
  tracker.resetModelLeg();
  tracker.recordModelCall();
  tracker.accumulateStep(
    { inputTokens: 200, outputTokens: 20, raw: { cost: 3 } },
    "model",
  );
  expect(tracker.computeModelCostDollars("model")).toBe(4);
  expect(tracker.measurementProperties("model")).toMatchObject({
    usage_model_calls_started: 2,
    usage_model_records: 2,
    usage_summary_records: 1,
    usage_retry_resets: 1,
    usage_observed_model_cost_dollars: 6.5,
    usage_discarded_retry_cost_dollars: 2.5,
    usage_summary_cost_dollars: 1,
    usage_observed_input_tokens: 350,
    usage_cache_read_reported_records: 2,
    usage_cache_covered_input_tokens: 150,
    usage_cache_covered_read_tokens: 25,
  });
});

it("distinguishes missing telemetry from explicit zero reads and unfinished calls", () => {
  const tracker = new UsageTracker();
  tracker.recordModelCall();
  expect(tracker.measurementProperties("model")).toMatchObject({
    usage_model_calls_started: 1,
    usage_model_records: 0,
    usage_provider_cost_records: 0,
    usage_cache_read_reported_records: 0,
  });
  tracker.accumulateStep(
    {
      inputTokens: 10,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    "model",
  );
  tracker.recordModelCall();
  tracker.accumulateStep(
    { inputTokens: 20, inputTokenDetails: { cacheWriteTokens: 0 } },
    "model",
  );
  expect(tracker.measurementProperties("model")).toMatchObject({
    usage_model_calls_started: 2,
    usage_model_records: 2,
    usage_cache_read_reported_records: 1,
    usage_cache_covered_input_tokens: 10,
    usage_cache_covered_read_tokens: 0,
  });
});
