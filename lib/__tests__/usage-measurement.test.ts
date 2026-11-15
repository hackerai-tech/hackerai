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
  tracker.prepareModelRetry();
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

it("reports known incurred cost across providers without changing billable cost", () => {
  const tracker = new UsageTracker();
  // Inference pre-output failure: billed today, served by Inference.
  tracker.accumulateStep(
    { inputTokens: 10, outputTokens: 1, raw: { cost: 0.5 } },
    "model-inference-cyber",
  );
  // Failed OpenRouter leg discarded by a provider retry.
  tracker.accumulateStep(
    { inputTokens: 10, outputTokens: 1, raw: { cost: 2 } },
    "deepseek/deepseek-v4-flash",
  );
  tracker.prepareModelRetry();
  tracker.accumulateStep(
    { inputTokens: 10, outputTokens: 1, raw: { cost: 0.25 } },
    "abliterated-model-large-flash",
  );
  tracker.accumulateSummarization({
    inputTokens: 5,
    outputTokens: 1,
    cost: 0.125,
    model: "z-ai/glm-5.3",
  });
  tracker.addTriggerRunCost(0.0625);

  const billable = tracker.computeCostDollars("model");
  // The discarded Inference and OpenRouter legs are not billable after retry.
  expect(billable).toBe(0.25 + 0.125 + 0.0625);
  expect(tracker.measurementProperties("model")).toMatchObject({
    usage_measurement_version: 2,
    usage_discarded_retry_cost_dollars: 2.5,
    usage_inference_model_cost_dollars: 0.5,
    usage_abliteration_model_cost_dollars: 0.25,
    usage_openrouter_model_cost_dollars: 2.125,
    usage_trigger_run_cost_dollars: 0.0625,
    usage_known_incurred_cost_dollars: 2.5 + 0.25 + 0.125 + 0.0625,
  });
});

it("keeps Trigger compute billable once and ignores invalid amounts", () => {
  const tracker = new UsageTracker();
  tracker.addTriggerRunCost(0.5);
  tracker.addTriggerRunCost(Number.NaN);
  tracker.addTriggerRunCost(-1);
  expect(tracker.nonModelCost).toBe(0.5);
  expect(tracker.hasUsage).toBe(true);
  expect(tracker.computeCostDollars("model")).toBe(0.5);
  expect(tracker.measurementProperties("model")).toMatchObject({
    usage_trigger_run_cost_dollars: 0.5,
    usage_known_incurred_cost_dollars: 0.5,
  });
});

it("marks a record without tokens or provider cost as unreported, not free", () => {
  const tracker = new UsageTracker();
  tracker.accumulateStep({}, "model");
  tracker.accumulateStep({ inputTokens: 0, raw: { cost: 0 } }, "model");
  expect(tracker.measurementProperties("model")).toMatchObject({
    usage_model_records: 2,
    usage_unreported_model_records: 1,
    usage_token_estimated_model_records: 1,
  });
});

it("exposes discarded-only work for measurement while nothing is billable", () => {
  const tracker = new UsageTracker();
  tracker.accumulateStep(
    { inputTokens: 100, outputTokens: 10, raw: { cost: 1 } },
    "model",
  );
  tracker.prepareModelRetry();
  expect(tracker.hasUsage).toBe(false);
  expect(tracker.hasIncurredMeasurement).toBe(true);
  expect(tracker.measurementProperties("model")).toMatchObject({
    usage_known_incurred_cost_dollars: 1,
  });
});

it("distinguishes missing telemetry from explicit zero reads and unfinished calls", () => {
  const tracker = new UsageTracker();
  expect(tracker.hasIncurredMeasurement).toBe(false);
  tracker.recordModelCall();
  // A started call can incur cost even when it fails before returning usage.
  expect(tracker.hasIncurredMeasurement).toBe(true);
  expect(tracker.hasUsage).toBe(false);
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
