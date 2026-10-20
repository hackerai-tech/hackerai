import { beforeEach, describe, expect, it, jest } from "@jest/globals";
const mockConfigured = jest.fn(() => true);
const mockFlag = jest.fn<() => Promise<boolean | null>>();
const mockEvent =
  jest.fn<(event: string, properties: Record<string, any>) => void>();
jest.mock("@/lib/ai/abliteration", () => ({
  ABLITERATION_MODEL_KEY: "model-abliterated",
  ABLITERATION_LARGE_V2_MODEL_KEY: "model-abliterated-large-v2",
  isAbliterationConfigured: mockConfigured,
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: mockEvent },
  getPostHogBooleanFlagDecisionForUser: mockFlag,
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
  platformAuthorized: false,
  onDiscardedUsage: jest.fn(),
};
describe("compaction model assignment and telemetry", () => {
  beforeEach(() => {
    mockConfigured.mockReturnValue(true);
    mockFlag.mockReset().mockResolvedValue(false);
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
      expect(assignment).toMatchObject({ model: "model-abliterated" });
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
    expect(await new CompactionModelPolicy(context).resolve()).toMatchObject({
      model: "model-glm-5.3-flash",
    });
    expect(mockEvent).not.toHaveBeenCalled();
  });
  it.each(["agent", "ask"] as const)(
    "expands only Agent Max compaction, mode=%s",
    async (mode) => {
      const assignment = await new CompactionModelPolicy({
        ...context,
        mode,
        expandedAgentContext: true,
      }).resolve();
      expect(assignment.model).toBe(
        mode === "agent" ? "model-abliterated-large-v2" : "model-abliterated",
      );
      expect(assignment.expandedAgentContext).toBe(
        mode === "agent" ? true : undefined,
      );
    },
  );
  it("preserves moderation-based selection with the larger Max fallback", async () => {
    mockFlag.mockResolvedValue(true);
    expect(
      await new CompactionModelPolicy({
        ...context,
        expandedAgentContext: true,
      }).resolve(),
    ).toMatchObject({
      model: "model-glm-5.3-flash",
      fallbackModel: "model-abliterated-large-v2",
      expandedAgentContext: true,
    });
  });
  it.each(["free", "pro", "pro-plus", "ultra", "team"] as const)(
    "uses the moderation decision for %s in Ask and Agent",
    async (subscription) => {
      mockFlag.mockResolvedValue(true);
      for (const mode of ["ask", "agent"] as const) {
        for (const platformAuthorized of [false, true]) {
          const policy = new CompactionModelPolicy({
            ...context,
            subscription,
            mode,
            platformAuthorized,
          });
          const assignment = await policy.resolve();
          expect(assignment).toMatchObject({
            model: platformAuthorized
              ? "model-abliterated"
              : "model-glm-5.3-flash",
            fallbackModel: platformAuthorized
              ? "model-glm-5.3-flash"
              : "model-abliterated",
            policy: "moderation_glm53_abliteration_recovery_v2",
            flagEnabled: true,
          });
          expect(mockEvent).not.toHaveBeenCalled();
          policy.start(assignment, "durable");
          expect(mockEvent).toHaveBeenLastCalledWith(
            "compaction_model_started",
            expect.objectContaining({
              compaction_flag_enabled: true,
              compaction_moderation_routed: platformAuthorized,
              assigned_model: assignment.model,
            }),
          );
          mockEvent.mockClear();
        }
      }
    },
  );
  it("retains control and records unknown when flag evaluation is unavailable", async () => {
    mockFlag.mockResolvedValue(null);
    const policy = new CompactionModelPolicy(context);
    const assignment = await policy.resolve();
    expect(assignment).toMatchObject({
      model: "model-abliterated",
      flagEnabled: null,
      policy: COMPACTION_POLICY_VERSION,
    });
    policy.start(assignment, "durable");
    expect(mockEvent).toHaveBeenLastCalledWith(
      "compaction_model_started",
      expect.objectContaining({ compaction_flag_enabled: null }),
    );
  });
  it.each([
    [false, true],
    [true, false],
  ])(
    "does not report moderation routing for flag=%s configured=%s",
    async (flagEnabled, configured) => {
      mockFlag.mockResolvedValue(flagEnabled);
      mockConfigured.mockReturnValue(configured);
      const policy = new CompactionModelPolicy({
        ...context,
        platformAuthorized: true,
      });
      policy.start(await policy.resolve(), "durable");
      expect(mockEvent).toHaveBeenLastCalledWith(
        "compaction_model_started",
        expect.objectContaining({
          compaction_moderation_selected: true,
          compaction_moderation_routed: false,
        }),
      );
    },
  );
  it("keeps GLM without an Abliteration fallback when credentials are absent", async () => {
    mockFlag.mockResolvedValue(true);
    mockConfigured.mockReturnValue(false);
    for (const platformAuthorized of [false, true]) {
      const assignment = await new CompactionModelPolicy({
        ...context,
        platformAuthorized,
      }).resolve();
      expect(assignment.model).toBe("model-glm-5.3-flash");
      expect(assignment.fallbackModel).toBeUndefined();
    }
  });
  it("evaluates once across repeated compactions even if the remote flag changes", async () => {
    mockFlag.mockResolvedValue(true);
    const policy = new CompactionModelPolicy(context);
    const first = await policy.resolve();
    mockFlag.mockResolvedValue(false);
    expect(await policy.resolve()).toBe(first);
    expect(mockFlag).toHaveBeenCalledTimes(1);
    expect(mockFlag).toHaveBeenCalledWith(
      "moderation_compaction_recovery_v2",
      "test-user",
      { subscription_tier: "pro" },
      { sendFeatureFlagEvents: false },
    );
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
