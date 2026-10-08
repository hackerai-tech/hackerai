import { beforeEach, describe, expect, it, jest } from "@jest/globals";
const mockFlag = jest.fn<(...args: any[]) => Promise<string | undefined>>();
const mockConfigured = jest.fn(() => true);
const mockEvent =
  jest.fn<(event: string, properties: Record<string, any>) => void>();
jest.mock("@/lib/ai/abliteration", () => ({
  ABLITERATION_MODEL_KEY: "model-abliterated",
  isAbliterationConfigured: mockConfigured,
}));
jest.mock("@/lib/posthog/server", () => ({
  getPostHogFeatureFlagVariantForUser: mockFlag,
  phLogger: { event: mockEvent },
}));
const {
  CompactionModelExperiment,
  COMPACTION_MODEL_FLAG,
  hasStructuredCompactionSummary,
} = require("../compaction-model") as typeof import("../compaction-model");
const context = {
  userId: "test-user",
  runId: "run-test",
  chatId: "chat-test",
  mode: "agent" as const,
  subscription: "pro" as const,
  baselineModel: "agent-model",
  onDiscardedUsage: jest.fn(),
};
describe("compaction model assignment and telemetry", () => {
  beforeEach(() => {
    mockFlag.mockReset();
    mockConfigured.mockReturnValue(true);
    mockEvent.mockClear();
  });
  it.each(["control", "test"] as const)(
    "freezes %s per run and defers exposure until a real compaction",
    async (variant) => {
      mockFlag.mockResolvedValueOnce(variant);
      const experiment = new CompactionModelExperiment(context);
      const assignment = await experiment.resolve();
      expect(await experiment.resolve()).toBe(assignment);
      expect(mockFlag).toHaveBeenCalledTimes(1);
      expect(mockFlag).toHaveBeenCalledWith(
        COMPACTION_MODEL_FLAG,
        "test-user",
        expect.objectContaining({ sendFeatureFlagEvents: false }),
      );
      expect(mockEvent).not.toHaveBeenCalled();
      const first = experiment.start(assignment!, "durable");
      first.attempt(assignment!.model, "error", 3);
      first.attempt("model-glm-5.3-flash", "completed", 4, {
        inputTokens: 0,
        inputTokensReported: true,
        outputTokens: 0,
        cost: 0,
      });
      first.finish("completed", "model-glm-5.3-flash");
      const second = experiment.start(assignment!, "run_scoped");
      second.attempt(assignment!.model, "aborted", 2);
      second.finish("aborted");
      expect(
        mockEvent.mock.calls.filter(
          ([event]) => event === "$feature_flag_called",
        ),
      ).toHaveLength(1);
      const outcomes = mockEvent.mock.calls.filter(
        ([event]) => event === "compaction_model_finished",
      );
      expect(outcomes[0][1]).toMatchObject({
        experiment_variant: variant,
        primary_success: false,
        fallback_used: true,
        attempt_count: 2,
      });
      expect(outcomes[1][1]).toMatchObject({
        outcome: "aborted",
        primary_success: false,
      });
      expect(outcomes[0][1].compaction_id).not.toEqual(
        outcomes[1][1].compaction_id,
      );
      const attempts = mockEvent.mock.calls.filter(
        ([event]) => event === "compaction_model_attempt_finished",
      );
      expect(attempts[0][1]).toMatchObject({
        cost_dollars: null,
        usage_reported: false,
        input_tokens: null,
      });
      expect(attempts[1][1]).toMatchObject({
        cost_dollars: 0,
        usage_reported: true,
        input_tokens: 0,
      });
      expect(JSON.stringify(mockEvent.mock.calls)).not.toContain(
        "error_message",
      );
    },
  );
  it("does not enroll free users or an unconfigured provider", async () => {
    expect(
      await new CompactionModelExperiment({
        ...context,
        subscription: "free",
      }).resolve(),
    ).toBeUndefined();
    mockConfigured.mockReturnValue(false);
    expect(
      await new CompactionModelExperiment(context).resolve(),
    ).toBeUndefined();
    expect(mockFlag).not.toHaveBeenCalled();
  });
  it("keeps unavailable or out-of-rollout assignment outside the experiment", async () => {
    mockFlag.mockResolvedValue(undefined);
    expect(
      await new CompactionModelExperiment(context).resolve(),
    ).toBeUndefined();
    expect(mockEvent).not.toHaveBeenCalled();
  });
  it("rejects refusal prose and incomplete structured output", () => {
    expect(
      hasStructuredCompactionSummary(
        "I cannot summarize this content",
        "agent",
      ),
    ).toBe(false);
    expect(
      hasStructuredCompactionSummary("## Current State\n(none)", "ask"),
    ).toBe(false);
  });
});
