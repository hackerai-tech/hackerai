import { beforeEach, describe, expect, it, jest } from "@jest/globals";
const mockConfigured = jest.fn(() => true);
const mockEvent =
  jest.fn<(event: string, properties: Record<string, any>) => void>();
jest.mock("@/lib/ai/abliteration", () => ({
  ABLITERATION_MODEL_KEY: "model-abliterated",
  isAbliterationConfigured: mockConfigured,
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: mockEvent },
}));
const {
  CompactionModelPolicy,
  COMPACTION_POLICY_VERSION,
  hasStructuredCompactionSummary,
} = require("../compaction-policy") as typeof import("../compaction-policy");
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
    mockConfigured.mockReturnValue(true);
    mockEvent.mockClear();
  });
  it.each(["free", "pro", "pro-plus", "ultra", "team"] as const)(
    "uses Abliteration for %s and emits policy telemetry only at compaction",
    async (subscription) => {
      const experiment = new CompactionModelPolicy({
        ...context,
        subscription,
      });
      const assignment = await experiment.resolve();
      expect(await experiment.resolve()).toBe(assignment);
      expect(assignment).toEqual({ model: "model-abliterated" });
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
      ).toHaveLength(0);
      const outcomes = mockEvent.mock.calls.filter(
        ([event]) => event === "compaction_model_finished",
      );
      expect(outcomes[0][1]).toMatchObject({
        compaction_policy: COMPACTION_POLICY_VERSION,
        subscription_tier: subscription,
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
      const serializedEvents = JSON.stringify(mockEvent.mock.calls);
      expect(serializedEvents).not.toContain("experiment_key");
      expect(serializedEvents).not.toContain("experiment_variant");
      expect(serializedEvents).not.toContain("error_message");
    },
  );
  it("starts with GLM when Abliteration credentials are missing", async () => {
    mockConfigured.mockReturnValue(false);
    expect(await new CompactionModelPolicy(context).resolve()).toEqual({
      model: "model-glm-5.3-flash",
    });
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
