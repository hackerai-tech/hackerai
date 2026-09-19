import {
  createUltraMaxModelExposureRecorder,
  evaluateUltraMaxModel,
  getActiveUltraMaxModelAssignment,
  ULTRA_MAX_MODEL_EXPERIMENT_KEY,
  ULTRA_MAX_MODEL_EXPOSURE_EVENT,
} from "@/lib/experiments/ultra-max-model";

const eligible = {
  userId: "ultra-user",
  subscription: "ultra" as const,
  mode: "ask" as const,
  selectedModel: "model-grok-4.6" as const,
  hasImages: false,
};

const flags = (variant: unknown) => ({
  getFeatureFlag: jest.fn(async () => variant),
});

describe("Ultra Max model experiment", () => {
  it.each([
    ["control", "model-grok-4.6", "x-ai/grok-4.6"],
    ["test", "model-glm-5.3", "z-ai/glm-5.3"],
  ] as const)(
    "routes the %s variant",
    async (variant, modelKey, configuredModel) => {
      const posthog = flags(variant);
      await expect(
        evaluateUltraMaxModel({ ...eligible, posthog: posthog as never }),
      ).resolves.toEqual({
        key: ULTRA_MAX_MODEL_EXPERIMENT_KEY,
        variant,
        modelKey,
        configuredModel,
      });
      expect(posthog.getFeatureFlag).toHaveBeenCalledWith(
        ULTRA_MAX_MODEL_EXPERIMENT_KEY,
        "ultra-user",
        {
          sendFeatureFlagEvents: false,
          personProperties: {
            subscription: "ultra",
            subscription_tier: "ultra",
          },
        },
      );
    },
  );

  it.each([
    { ...eligible, subscription: "pro" as const },
    { ...eligible, subscription: "pro-plus" as const },
    { ...eligible, subscription: "team" as const },
    { ...eligible, selectedModel: "model-grok-4.6-pro" as const },
    { ...eligible, selectedModel: "model-glm-5.3" as const },
    { ...eligible, hasImages: true },
    { ...eligible, userId: "" },
  ])("does not evaluate excluded requests: %j", async (scope) => {
    const posthog = flags("test");
    await expect(
      evaluateUltraMaxModel({ ...scope, posthog: posthog as never }),
    ).resolves.toBeUndefined();
    expect(posthog.getFeatureFlag).not.toHaveBeenCalled();
  });

  it.each([true, false, undefined, "unknown"])(
    "retains Grok for invalid assignment %s",
    async (variant) => {
      await expect(
        evaluateUltraMaxModel({
          ...eligible,
          posthog: flags(variant) as never,
        }),
      ).resolves.toBeUndefined();
    },
  );

  it("fails closed when PostHog is missing or unavailable", async () => {
    await expect(
      evaluateUltraMaxModel({ ...eligible, posthog: null }),
    ).resolves.toBeUndefined();
    await expect(
      evaluateUltraMaxModel({
        ...eligible,
        posthog: {
          getFeatureFlag: jest.fn().mockRejectedValue(new Error("offline")),
        } as never,
      }),
    ).resolves.toBeUndefined();
  });

  it.each(["control", "test"] as const)(
    "drops %s after rescue or a later reroute",
    async (variant) => {
      const assignment = await evaluateUltraMaxModel({
        ...eligible,
        posthog: flags(variant) as never,
      });
      expect(
        getActiveUltraMaxModelAssignment(
          assignment,
          assignment!.modelKey,
          false,
        ),
      ).toBe(assignment);
      expect(
        getActiveUltraMaxModelAssignment(
          assignment,
          assignment!.modelKey,
          true,
        ),
      ).toBeUndefined();
      expect(
        getActiveUltraMaxModelAssignment(assignment, "model-kimi-k3", false),
      ).toBeUndefined();
    },
  );

  it("records one exposure only when the assigned provider request starts", async () => {
    const assignment = await evaluateUltraMaxModel({
      ...eligible,
      mode: "agent",
      posthog: flags("test") as never,
    });
    const capture = jest.fn();
    const record = createUltraMaxModelExposureRecorder({
      ...eligible,
      mode: "agent",
      posthog: { capture } as never,
      assignment,
      requestId: "request-1",
    });

    record("x-ai/grok-4.6");
    expect(capture).not.toHaveBeenCalled();
    record("z-ai/glm-5.3");
    record("z-ai/glm-5.3");
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith({
      distinctId: "ultra-user",
      event: ULTRA_MAX_MODEL_EXPOSURE_EVENT,
      properties: {
        experiment_key: ULTRA_MAX_MODEL_EXPERIMENT_KEY,
        experiment_variant: "test",
        [`$feature/${ULTRA_MAX_MODEL_EXPERIMENT_KEY}`]: "test",
        subscription: "ultra",
        subscription_tier: "ultra",
        mode: "agent",
        selected_model: "model-glm-5.3",
        configured_model: "z-ai/glm-5.3",
        request_id: "request-1",
        exposure_surface: "provider_request",
        $process_person_profile: false,
      },
    });
  });

  it("does not interrupt generation when exposure capture throws", async () => {
    const assignment = await evaluateUltraMaxModel({
      ...eligible,
      posthog: flags("control") as never,
    });
    const record = createUltraMaxModelExposureRecorder({
      ...eligible,
      assignment,
      requestId: "request-1",
      posthog: {
        capture: () => {
          throw new Error("offline");
        },
      } as never,
    });
    expect(() => record("x-ai/grok-4.6")).not.toThrow();
  });
});
