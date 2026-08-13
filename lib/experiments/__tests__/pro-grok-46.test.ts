import {
  captureProGrok46ExperimentExposure,
  evaluateProGrok46Experiment,
  getActiveProGrok46ExperimentAssignment,
  getProGrok46ExperimentContext,
  isEligibleForProGrok46Experiment,
  PRO_GROK_46_EXPERIMENT_KEY,
  PRO_GROK_46_EXPOSURE_EVENT,
  PRO_GROK_46_FEATURE_PROPERTY,
} from "@/lib/experiments/pro-grok-46";

describe("Pro Grok 4.6 experiment", () => {
  it.each(["pro", "pro-plus", "ultra"] as const)(
    "includes %s users who select HackerAI Pro Agent",
    (subscription) => {
      expect(
        isEligibleForProGrok46Experiment({
          subscription,
          mode: "agent",
          selectedModel: "hackerai-pro",
        }),
      ).toBe(true);
    },
  );

  it.each([
    ["free", "agent", "hackerai-pro"],
    ["team", "agent", "hackerai-pro"],
    ["pro", "ask", "hackerai-pro"],
    ["pro", "agent", "auto"],
    ["pro", "agent", "hackerai-standard"],
    ["pro", "agent", "hackerai-max"],
  ] as const)(
    "excludes subscription=%s mode=%s selectedModel=%s",
    (subscription, mode, selectedModel) => {
      expect(
        isEligibleForProGrok46Experiment({
          subscription,
          mode,
          selectedModel,
        }),
      ).toBe(false);
    },
  );

  it.each([
    ["control", "model-grok-4.5-pro"],
    ["grok_4_6", "model-grok-4.6-pro"],
  ] as const)("maps %s to %s", async (variant, modelKey) => {
    const evaluateFlags = jest.fn(async () => ({ getFlag: () => variant }));

    await expect(
      evaluateProGrok46Experiment({
        posthog: { evaluateFlags } as never,
        userId: "user-1",
        subscription: "pro",
        mode: "agent",
        selectedModel: "hackerai-pro",
      }),
    ).resolves.toEqual({
      key: PRO_GROK_46_EXPERIMENT_KEY,
      variant,
      modelKey,
    });
  });

  it("fails closed when evaluation returns an unknown value", async () => {
    await expect(
      evaluateProGrok46Experiment({
        posthog: {
          evaluateFlags: jest.fn(async () => ({ getFlag: () => true })),
        } as never,
        userId: "user-1",
        subscription: "pro",
        mode: "agent",
        selectedModel: "hackerai-pro",
      }),
    ).resolves.toBeUndefined();
  });

  it("captures a privacy-safe custom exposure from the provider surface", () => {
    const capture = jest.fn();
    const assignment = {
      key: PRO_GROK_46_EXPERIMENT_KEY,
      variant: "grok_4_6" as const,
      modelKey: "model-grok-4.6-pro" as const,
    };

    captureProGrok46ExperimentExposure({
      posthog: { capture } as never,
      userId: "user-1",
      subscription: "pro",
      mode: "agent",
      selectedModel: assignment.modelKey,
      configuredModel: "x-ai/grok-4.6",
      assignment,
    });

    expect(capture).toHaveBeenCalledWith({
      distinctId: "user-1",
      event: PRO_GROK_46_EXPOSURE_EVENT,
      properties: {
        experiment_key: PRO_GROK_46_EXPERIMENT_KEY,
        experiment_variant: "grok_4_6",
        [PRO_GROK_46_FEATURE_PROPERTY]: "grok_4_6",
        subscription: "pro",
        subscription_tier: "pro",
        mode: "agent",
        selected_model: "model-grok-4.6-pro",
        configured_model: "x-ai/grok-4.6",
        exposure_surface: "agent_provider_request",
        $process_person_profile: false,
      },
    });
    expect(getProGrok46ExperimentContext(assignment)).toEqual({
      key: PRO_GROK_46_EXPERIMENT_KEY,
      variant: "grok_4_6",
    });
    expect(
      getActiveProGrok46ExperimentAssignment(assignment, "model-grok-4.6-pro"),
    ).toBe(assignment);
    expect(
      getActiveProGrok46ExperimentAssignment(assignment, "agent-model"),
    ).toBeUndefined();
  });
});
