import {
  capturePaidAgentGlm53FlashExperimentExposure,
  evaluatePaidAgentGlm53FlashExperiment,
  getActivePaidAgentGlm53FlashExperimentAssignment,
  getPaidAgentGlm53FlashExperimentContext,
  isEligibleForPaidAgentGlm53FlashExperiment,
  PAID_AGENT_GLM_5_3_FLASH_EXPERIMENT_KEY,
  PAID_AGENT_GLM_5_3_FLASH_EXPOSURE_EVENT,
  PAID_AGENT_GLM_5_3_FLASH_FEATURE_PROPERTY,
} from "@/lib/experiments/paid-agent-glm-5-3-flash";

describe("paid Agent GLM 5.3 Flash experiment", () => {
  it("only includes paid Agent requests already resolved to DeepSeek Flash", () => {
    expect(
      isEligibleForPaidAgentGlm53FlashExperiment({
        mode: "agent",
        subscription: "pro",
        selectedModel: "model-deepseek-v4-flash-0731",
      }),
    ).toBe(true);
    expect(
      isEligibleForPaidAgentGlm53FlashExperiment({
        mode: "ask",
        subscription: "pro",
        selectedModel: "model-deepseek-v4-flash-0731",
      }),
    ).toBe(false);
    expect(
      isEligibleForPaidAgentGlm53FlashExperiment({
        mode: "agent",
        subscription: "free",
        selectedModel: "model-deepseek-v4-flash-0731",
      }),
    ).toBe(false);
    expect(
      isEligibleForPaidAgentGlm53FlashExperiment({
        mode: "agent",
        subscription: "ultra",
        selectedModel: "model-deepseek-v4-pro-0813",
      }),
    ).toBe(false);
  });

  it.each([
    ["control", "model-deepseek-v4-flash-0731"],
    ["test", "model-glm-5.3-flash-agent"],
  ] as const)("maps %s to %s", async (variant, modelKey) => {
    const evaluateFlags = jest.fn(async () => ({ getFlag: () => variant }));

    await expect(
      evaluatePaidAgentGlm53FlashExperiment({
        posthog: { evaluateFlags } as never,
        userId: "user-1",
        mode: "agent",
        subscription: "pro",
        selectedModel: "model-deepseek-v4-flash-0731",
      }),
    ).resolves.toEqual({
      key: PAID_AGENT_GLM_5_3_FLASH_EXPERIMENT_KEY,
      variant,
      modelKey,
    });
  });

  it("does not evaluate ineligible routes and fails closed on unknown values", async () => {
    const evaluateFlags = jest.fn();
    await expect(
      evaluatePaidAgentGlm53FlashExperiment({
        posthog: { evaluateFlags } as never,
        userId: "user-1",
        mode: "agent",
        subscription: "free",
        selectedModel: "agent-model-free",
      }),
    ).resolves.toBeUndefined();
    expect(evaluateFlags).not.toHaveBeenCalled();

    await expect(
      evaluatePaidAgentGlm53FlashExperiment({
        posthog: {
          evaluateFlags: jest.fn(async () => ({ getFlag: () => true })),
        } as never,
        userId: "user-1",
        mode: "agent",
        subscription: "pro",
        selectedModel: "model-deepseek-v4-flash-0731",
      }),
    ).resolves.toBeUndefined();
  });

  it("captures privacy-safe provider-request exposure and analytics context", () => {
    const capture = jest.fn();
    const assignment = {
      key: PAID_AGENT_GLM_5_3_FLASH_EXPERIMENT_KEY,
      variant: "test" as const,
      modelKey: "model-glm-5.3-flash-agent" as const,
    };

    capturePaidAgentGlm53FlashExperimentExposure({
      posthog: { capture } as never,
      userId: "user-1",
      subscription: "pro-plus",
      mode: "agent",
      selectedModelOverride: "hackerai-standard",
      selectedModel: assignment.modelKey,
      configuredModel: "z-ai/glm-5.3-flash",
      assignment,
    });

    expect(capture).toHaveBeenCalledWith({
      distinctId: "user-1",
      event: PAID_AGENT_GLM_5_3_FLASH_EXPOSURE_EVENT,
      properties: {
        experiment_key: PAID_AGENT_GLM_5_3_FLASH_EXPERIMENT_KEY,
        experiment_variant: "test",
        [PAID_AGENT_GLM_5_3_FLASH_FEATURE_PROPERTY]: "test",
        subscription: "pro-plus",
        subscription_tier: "pro-plus",
        mode: "agent",
        selected_model: "model-glm-5.3-flash-agent",
        selected_model_override: "hackerai-standard",
        configured_model: "z-ai/glm-5.3-flash",
        exposure_surface: "agent_provider_request",
        $process_person_profile: false,
      },
    });
    expect(getPaidAgentGlm53FlashExperimentContext(assignment)).toEqual({
      key: PAID_AGENT_GLM_5_3_FLASH_EXPERIMENT_KEY,
      variant: "test",
    });
    expect(
      getActivePaidAgentGlm53FlashExperimentAssignment(
        assignment,
        "model-glm-5.3-flash-agent",
      ),
    ).toBe(assignment);
    expect(
      getActivePaidAgentGlm53FlashExperimentAssignment(
        assignment,
        "model-deepseek-v4-flash-0731",
      ),
    ).toBeUndefined();
  });
});
