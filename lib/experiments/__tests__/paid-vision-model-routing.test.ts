import {
  capturePaidVisionModelRoutingExposure,
  evaluatePaidVisionModelRoutingExperiment,
  getActivePaidVisionModelRoutingAssignment,
  getPaidVisionModelRoutingExperimentContext,
  getPaidVisionTier,
  PAID_VISION_MODEL_ROUTING_EXPERIMENT_KEY,
  PAID_VISION_MODEL_ROUTING_EXPOSURE_EVENT,
  PAID_VISION_MODEL_ROUTING_FEATURE_PROPERTY,
} from "@/lib/experiments/paid-vision-model-routing";

describe("paid vision model routing experiment", () => {
  it("includes paid Auto, Standard, and Pro while excluding free and Max", () => {
    expect(getPaidVisionTier("pro", undefined)).toBe("auto_standard");
    expect(getPaidVisionTier("pro", "auto")).toBe("auto_standard");
    expect(getPaidVisionTier("pro", "hackerai-standard")).toBe("auto_standard");
    expect(getPaidVisionTier("pro", "hackerai-pro")).toBe("pro");
    expect(getPaidVisionTier("free", "hackerai-pro")).toBeUndefined();
    expect(getPaidVisionTier("pro-plus", "hackerai-max")).toBeUndefined();
  });

  it.each([
    ["control", undefined, "model-grok-4.6", "high", "auto_standard"],
    ["test", "hackerai-standard", "model-grok-4.5", "medium", "auto_standard"],
    ["test", "hackerai-pro", "model-grok-4.5-pro", "high", "pro"],
  ] as const)(
    "maps %s for %s to %s with %s reasoning",
    async (
      variant,
      selectedModelOverride,
      modelKey,
      reasoningEffort,
      visionTier,
    ) => {
      const evaluateFlags = jest.fn(async () => ({ getFlag: () => variant }));

      await expect(
        evaluatePaidVisionModelRoutingExperiment({
          posthog: { evaluateFlags } as never,
          userId: "user-1",
          subscription: "pro",
          selectedModelOverride,
        }),
      ).resolves.toEqual({
        key: PAID_VISION_MODEL_ROUTING_EXPERIMENT_KEY,
        variant,
        visionTier,
        modelKey,
        reasoningEffort,
      });
    },
  );

  it("does not evaluate excluded requests and fails closed on unknown values", async () => {
    const evaluateFlags = jest.fn(async () => ({ getFlag: () => true }));

    await expect(
      evaluatePaidVisionModelRoutingExperiment({
        posthog: { evaluateFlags } as never,
        userId: "user-1",
        subscription: "free",
      }),
    ).resolves.toBeUndefined();
    expect(evaluateFlags).not.toHaveBeenCalled();

    await expect(
      evaluatePaidVisionModelRoutingExperiment({
        posthog: { evaluateFlags } as never,
        userId: "user-1",
        subscription: "pro",
      }),
    ).resolves.toBeUndefined();
  });

  it("captures only privacy-safe routing metadata at actual exposure", () => {
    const capture = jest.fn();
    const assignment = {
      key: PAID_VISION_MODEL_ROUTING_EXPERIMENT_KEY,
      variant: "test" as const,
      visionTier: "auto_standard" as const,
      modelKey: "model-grok-4.5" as const,
      reasoningEffort: "medium" as const,
    };

    capturePaidVisionModelRoutingExposure({
      posthog: { capture } as never,
      userId: "user-1",
      subscription: "pro",
      mode: "agent",
      selectedModelOverride: "hackerai-standard",
      configuredModel: "x-ai/grok-4.5",
      exposureSurface: "agent_image_tool_result",
      assignment,
    });

    expect(capture).toHaveBeenCalledWith({
      distinctId: "user-1",
      event: PAID_VISION_MODEL_ROUTING_EXPOSURE_EVENT,
      properties: {
        experiment_key: PAID_VISION_MODEL_ROUTING_EXPERIMENT_KEY,
        experiment_variant: "test",
        [PAID_VISION_MODEL_ROUTING_FEATURE_PROPERTY]: "test",
        subscription_tier: "pro",
        mode: "agent",
        selected_model_override: "hackerai-standard",
        vision_tier: "auto_standard",
        configured_model: "x-ai/grok-4.5",
        reasoning_effort: "medium",
        exposure_surface: "agent_image_tool_result",
        $process_person_profile: false,
      },
    });
    expect(getPaidVisionModelRoutingExperimentContext(assignment)).toEqual({
      key: PAID_VISION_MODEL_ROUTING_EXPERIMENT_KEY,
      variant: "test",
    });
  });

  it("keeps assignments active only on their vision route or eligible paid text routes", () => {
    const assignment = {
      key: PAID_VISION_MODEL_ROUTING_EXPERIMENT_KEY,
      variant: "test" as const,
      visionTier: "pro" as const,
      modelKey: "model-grok-4.5-pro" as const,
      reasoningEffort: "high" as const,
    };

    expect(
      getActivePaidVisionModelRoutingAssignment(
        assignment,
        "model-grok-4.5-pro",
      ),
    ).toBe(assignment);
    expect(
      getActivePaidVisionModelRoutingAssignment(
        assignment,
        "model-deepseek-v4-pro-0813",
      ),
    ).toBe(assignment);
    expect(
      getActivePaidVisionModelRoutingAssignment(assignment, "agent-model-free"),
    ).toBeUndefined();
  });
});
