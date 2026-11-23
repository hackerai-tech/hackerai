import { beforeEach, describe, expect, it, jest } from "@jest/globals";
const mockInferenceConfigured = jest.fn(() => false);
const mockFlag = jest.fn<() => Promise<boolean | null>>();
const mockEvent =
  jest.fn<(event: string, properties: Record<string, any>) => void>();
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: mockEvent },
  getPostHogBooleanFlagDecisionForUser: mockFlag,
}));
jest.mock("@/lib/ai/inference", () => ({
  ...jest.requireActual<typeof import("@/lib/ai/inference")>(
    "@/lib/ai/inference",
  ),
  isInferenceConfigured: mockInferenceConfigured,
}));
const {
  CompactionModelPolicy,
  COMPACTION_POLICY_VERSION,
  hasStructuredCompactionSummary,
} = require("../compaction-policy") as typeof import("../compaction-policy");
const DEEPSEEK_1017 = "model-deepseek-v4.1-flash-1017-pro";
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
const enableInference = () => {
  mockInferenceConfigured.mockReturnValue(true);
  mockFlag.mockResolvedValue(true);
};
describe("compaction model assignment and telemetry", () => {
  beforeEach(() => {
    mockInferenceConfigured.mockReturnValue(false);
    mockFlag.mockReset().mockResolvedValue(false);
    mockEvent.mockClear();
  });
  it.each(["free", "pro", "pro-plus", "ultra", "team"] as const)(
    "uses Inference first with DeepSeek recovery for %s compaction in Ask and Agent",
    async (subscription) => {
      enableInference();
      for (const mode of ["ask", "agent"] as const) {
        const policy = new CompactionModelPolicy({
          ...context,
          subscription,
          mode,
        });
        const assignment = await policy.resolve();
        expect(assignment).toMatchObject({
          model: "model-inference-cyber",
          fallbackModel: DEEPSEEK_1017,
          policy: "inference_abliteration_fallback_v1",
          flagEnabled: true,
        });
        expect(await policy.resolve()).toBe(assignment);
        policy.start(assignment, "durable");
        expect(mockEvent).toHaveBeenLastCalledWith(
          "compaction_model_started",
          expect.objectContaining({
            assigned_model: "model-inference-cyber",
            compaction_flag_key: "inference_cyber_v1",
            compaction_flag_enabled: true,
          }),
        );
      }
    },
  );
  it.each([
    ["hackerai-pro", "pro_inference_context_v1"],
    ["hackerai-max", "max_inference_context_v1"],
  ] as const)(
    "retains %s expanded context and DeepSeek recovery",
    async (selectedModel, policy) => {
      enableInference();
      expect(
        await new CompactionModelPolicy({
          ...context,
          selectedModel,
          expandedAgentContext: true,
        }).resolve(),
      ).toMatchObject({
        model: "model-inference-cyber",
        fallbackModel: DEEPSEEK_1017,
        expandedAgentContext: true,
        policy,
      });
    },
  );
  it.each([false, null])(
    "uses GLM without a fallback when the Inference flag is %s",
    async (flag) => {
      mockInferenceConfigured.mockReturnValue(true);
      mockFlag.mockResolvedValue(flag);
      const assignment = await new CompactionModelPolicy(context).resolve();
      expect(assignment).toMatchObject({
        model: "model-glm-5.3-flash",
        policy: COMPACTION_POLICY_VERSION,
        flagEnabled: false,
      });
      expect(assignment.fallbackModel).toBeUndefined();
    },
  );
  it("uses GLM for every authorization context without a flag lookup when Inference is not configured", async () => {
    for (const platformAuthorized of [false, true]) {
      const policy = new CompactionModelPolicy({
        ...context,
        platformAuthorized,
      });
      const assignment = await policy.resolve();
      expect(assignment).toMatchObject({
        model: "model-glm-5.3-flash",
        policy: COMPACTION_POLICY_VERSION,
        flagEnabled: false,
      });
      expect(assignment.fallbackModel).toBeUndefined();
      expect(mockEvent).not.toHaveBeenCalled();
      policy.start(assignment, "durable");
      expect(mockEvent).toHaveBeenLastCalledWith(
        "compaction_model_started",
        expect.objectContaining({
          assigned_model: "model-glm-5.3-flash",
          compaction_flag_key: null,
          compaction_flag_enabled: false,
          compaction_moderation_selected: platformAuthorized,
        }),
      );
      mockEvent.mockClear();
    }
    expect(mockFlag).not.toHaveBeenCalled();
  });
  it("records safe provider rejection facts without response content", async () => {
    const policy = new CompactionModelPolicy(context);
    const attempt = policy.start(await policy.resolve(), "run_scoped");
    attempt.attempt(
      "model-inference-cyber",
      "error",
      1907,
      undefined,
      "provider_error",
      {
        statusCode: 400,
        responseBody: JSON.stringify({
          error: {
            code: "too_many_tool_calls",
            message: "private customer content",
          },
        }),
      },
    );
    const properties = mockEvent.mock.calls.find(
      ([name]) => name === "compaction_model_attempt_finished",
    )![1];
    expect(properties).toMatchObject({
      provider_status_code: 400,
      provider_error_code: "too_many_tool_calls",
    });
    expect(JSON.stringify(properties)).not.toContain(
      "private customer content",
    );
  });
  it.each(["free", "pro", "pro-plus", "ultra", "team"] as const)(
    "records Inference recovery for %s and emits policy telemetry only at compaction",
    async (subscription) => {
      enableInference();
      const experiment = new CompactionModelPolicy({
        ...context,
        subscription,
      });
      const assignment = await experiment.resolve();
      expect(await experiment.resolve()).toBe(assignment);
      expect(assignment).toMatchObject({ model: "model-inference-cyber" });
      expect(mockEvent).not.toHaveBeenCalled();
      const first = experiment.start(assignment!, "durable");
      first.attempt(assignment!.model, "error", 3);
      first.attempt(DEEPSEEK_1017, "completed", 4, {
        inputTokens: 0,
        inputTokensReported: true,
        outputTokens: 0,
        cost: 0,
      });
      first.finish("completed", DEEPSEEK_1017);
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
        compaction_policy: "inference_abliteration_fallback_v1",
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
  it.each([
    ["hackerai-max", "max_large_v2_context_v1"],
    ["hackerai-pro", "pro_large_v2_context_v1"],
  ] as const)(
    "keeps %s summary outcomes in their own cohort",
    async (selectedModel, expectedPolicy) => {
      const policy = new CompactionModelPolicy({
        ...context,
        selectedModel,
        expandedAgentContext: true,
      });
      const assignment = await policy.resolve();
      expect(assignment.model).toBe("model-glm-5.3-flash");
      const telemetry = policy.start(assignment, "run_scoped");
      telemetry.finish("completed", "model-glm-5.3-flash");
      expect(mockEvent).toHaveBeenCalledWith(
        "compaction_model_finished",
        expect.objectContaining({
          compaction_policy: expectedPolicy,
          outcome: "completed",
        }),
      );
    },
  );
  it.each([
    [false, "model-glm-5.3-flash", "paid_480k_large_v2_context_v1"],
    [true, "model-inference-cyber", "paid_480k_inference_context_v1"],
  ] as const)(
    "gives paid 480K runs expanded summaries in their own cohort (inference=%s)",
    async (inference, model, expectedPolicy) => {
      mockInferenceConfigured.mockReturnValue(inference);
      mockFlag.mockResolvedValue(inference);
      for (const selectedModel of [
        undefined,
        "auto",
        "hackerai-standard",
      ] as const) {
        const policy = new CompactionModelPolicy({
          ...context,
          selectedModel,
          agentContextPolicy: "paid_480k",
        });
        const assignment = await policy.resolve();
        expect(assignment).toMatchObject({
          model,
          expandedAgentContext: true,
          policy: expectedPolicy,
        });
        policy.start(assignment, "run_scoped").finish("completed", model);
        expect(mockEvent).toHaveBeenLastCalledWith(
          "compaction_model_finished",
          expect.objectContaining({ compaction_policy: expectedPolicy }),
        );
      }
      expect(JSON.stringify(mockEvent.mock.calls)).not.toContain(
        "paid_agent_context",
      );
    },
  );
  it("keeps baseline, Ask and explicit Pro/Max compaction out of the paid cohort", async () => {
    const baseline = await new CompactionModelPolicy({
      ...context,
      agentContextPolicy: "baseline",
    }).resolve();
    expect(baseline).toMatchObject({
      model: "model-glm-5.3-flash",
      policy: COMPACTION_POLICY_VERSION,
    });
    expect(baseline.expandedAgentContext).toBeUndefined();
    const ask = await new CompactionModelPolicy({
      ...context,
      mode: "ask",
      agentContextPolicy: "paid_480k",
    }).resolve();
    expect(ask.expandedAgentContext).toBeUndefined();
    expect(ask.policy).toBe(COMPACTION_POLICY_VERSION);
    expect(
      await new CompactionModelPolicy({
        ...context,
        selectedModel: "hackerai-pro",
        agentContextPolicy: "expanded",
      }).resolve(),
    ).toMatchObject({ policy: "pro_large_v2_context_v1" });
  });
  it.each(["agent", "ask"] as const)(
    "expands only Agent Max compaction, mode=%s",
    async (mode) => {
      const assignment = await new CompactionModelPolicy({
        ...context,
        mode,
        expandedAgentContext: true,
      }).resolve();
      expect(assignment.expandedAgentContext).toBe(
        mode === "agent" ? true : undefined,
      );
    },
  );
  it("evaluates once across repeated compactions even if the remote flag changes", async () => {
    enableInference();
    const policy = new CompactionModelPolicy(context);
    const first = await policy.resolve();
    mockFlag.mockResolvedValue(false);
    expect(await policy.resolve()).toBe(first);
    expect(mockFlag).toHaveBeenCalledTimes(1);
    expect(mockFlag).toHaveBeenCalledWith(
      "inference_cyber_v1",
      "test-user",
      { subscription: "pro", subscription_tier: "pro" },
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
