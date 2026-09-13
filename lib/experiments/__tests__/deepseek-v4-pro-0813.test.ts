import {
  captureDeepSeekV4Pro0813ExperimentExposure,
  DEEPSEEK_V4_PRO_0813_EXPERIMENT_KEY,
  DEEPSEEK_V4_PRO_0813_EXPOSURE_EVENT,
  DEEPSEEK_V4_PRO_0813_FEATURE_PROPERTY,
  evaluateDeepSeekV4Pro0813Experiment,
  getActiveDeepSeekV4Pro0813ExperimentAssignment,
  getDeepSeekV4Pro0813ExperimentContext,
  isEligibleForDeepSeekV4Pro0813Experiment,
} from "@/lib/experiments/deepseek-v4-pro-0813";

describe("DeepSeek V4 Pro 0813 experiment", () => {
  it("only evaluates requests already resolved to the current DeepSeek V4 Pro route", () => {
    expect(
      isEligibleForDeepSeekV4Pro0813Experiment("model-deepseek-v4-pro"),
    ).toBe(true);
    expect(isEligibleForDeepSeekV4Pro0813Experiment("model-grok-4.5")).toBe(
      false,
    );
    expect(isEligibleForDeepSeekV4Pro0813Experiment("agent-model-free")).toBe(
      false,
    );
  });

  it.each([
    ["control", "model-deepseek-v4-pro"],
    ["test", "model-deepseek-v4-pro-0813"],
  ] as const)("maps %s to %s", async (variant, modelKey) => {
    const evaluateFlags = jest.fn(async () => ({ getFlag: () => variant }));

    await expect(
      evaluateDeepSeekV4Pro0813Experiment({
        posthog: { evaluateFlags } as never,
        userId: "user-1",
        selectedModel: "model-deepseek-v4-pro",
      }),
    ).resolves.toEqual({
      key: DEEPSEEK_V4_PRO_0813_EXPERIMENT_KEY,
      variant,
      modelKey,
    });
  });

  it("does not evaluate ineligible routes", async () => {
    const evaluateFlags = jest.fn();

    await expect(
      evaluateDeepSeekV4Pro0813Experiment({
        posthog: { evaluateFlags } as never,
        userId: "user-1",
        selectedModel: "model-grok-4.5",
      }),
    ).resolves.toBeUndefined();
    expect(evaluateFlags).not.toHaveBeenCalled();
  });

  it("fails closed when evaluation returns an unknown value", async () => {
    await expect(
      evaluateDeepSeekV4Pro0813Experiment({
        posthog: {
          evaluateFlags: jest.fn(async () => ({ getFlag: () => true })),
        } as never,
        userId: "user-1",
        selectedModel: "model-deepseek-v4-pro",
      }),
    ).resolves.toBeUndefined();
  });

  it("captures a privacy-safe custom exposure from the provider surface", () => {
    const capture = jest.fn();
    const assignment = {
      key: DEEPSEEK_V4_PRO_0813_EXPERIMENT_KEY,
      variant: "test" as const,
      modelKey: "model-deepseek-v4-pro-0813" as const,
    };

    captureDeepSeekV4Pro0813ExperimentExposure({
      posthog: { capture } as never,
      userId: "user-1",
      subscription: "pro",
      mode: "agent",
      selectedModelOverride: "hackerai-standard",
      selectedModel: assignment.modelKey,
      configuredModel: "deepseek/deepseek-v4-pro-0813",
      assignment,
    });

    expect(capture).toHaveBeenCalledWith({
      distinctId: "user-1",
      event: DEEPSEEK_V4_PRO_0813_EXPOSURE_EVENT,
      properties: {
        experiment_key: DEEPSEEK_V4_PRO_0813_EXPERIMENT_KEY,
        experiment_variant: "test",
        [DEEPSEEK_V4_PRO_0813_FEATURE_PROPERTY]: "test",
        subscription: "pro",
        subscription_tier: "pro",
        mode: "agent",
        selected_model: "model-deepseek-v4-pro-0813",
        selected_model_override: "hackerai-standard",
        configured_model: "deepseek/deepseek-v4-pro-0813",
        exposure_surface: "provider_request",
        $process_person_profile: false,
      },
    });
    expect(getDeepSeekV4Pro0813ExperimentContext(assignment)).toEqual({
      key: DEEPSEEK_V4_PRO_0813_EXPERIMENT_KEY,
      variant: "test",
    });
    expect(
      getActiveDeepSeekV4Pro0813ExperimentAssignment(
        assignment,
        "model-deepseek-v4-pro-0813",
      ),
    ).toBe(assignment);
    expect(
      getActiveDeepSeekV4Pro0813ExperimentAssignment(
        assignment,
        "model-grok-4.5",
      ),
    ).toBeUndefined();
  });
});
