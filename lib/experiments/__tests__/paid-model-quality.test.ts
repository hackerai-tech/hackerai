import {
  capturePaidModelQualityExperimentExposure,
  capturePaidModelQualityRun,
  evaluatePaidModelQualityExperiment,
  getActivePaidModelQualityExperimentAssignment,
  getEligiblePaidModelQualityRoute,
  getPaidModelQualityExperimentContext,
  PAID_MODEL_QUALITY_EXPOSURE_EVENT,
  PAID_MODEL_QUALITY_RUN_EVENT,
  PAID_PRO_MODEL_QUALITY_EXPERIMENT_KEY,
  PAID_STANDARD_MODEL_QUALITY_EXPERIMENT_KEY,
} from "@/lib/experiments/paid-model-quality";

describe("paid model quality experiments", () => {
  it.each([
    ["ask", "model-deepseek-v4-flash-0731"],
    ["agent", "model-glm-5.3-flash-agent"],
  ] as const)(
    "recognizes the current %s Standard route",
    (mode, selectedModel) => {
      expect(
        getEligiblePaidModelQualityRoute({
          mode,
          subscription: "pro",
          selectedModel,
        }),
      ).toMatchObject({
        key: PAID_STANDARD_MODEL_QUALITY_EXPERIMENT_KEY,
        route: "standard",
        controlModelKey: selectedModel,
        previousModelKey: "model-deepseek-v4-pro",
      });
    },
  );

  it("recognizes the current Pro route", () => {
    expect(
      getEligiblePaidModelQualityRoute({
        mode: "agent",
        subscription: "pro-plus",
        selectedModel: "model-deepseek-v4-pro-0813",
      }),
    ).toMatchObject({
      key: PAID_PRO_MODEL_QUALITY_EXPERIMENT_KEY,
      route: "pro",
      previousModelKey: "model-grok-4.6-pro",
    });
  });

  it.each([
    ["free", "agent", "model-glm-5.3-flash-agent"],
    ["team", "agent", "model-glm-5.3-flash-agent"],
    ["ultra", "agent", "model-deepseek-v4-pro-0813"],
    ["pro", "agent", "model-grok-4.5"],
    ["pro", "ask", "model-glm-5.3-flash-agent"],
  ] as const)(
    "excludes %s %s route %s",
    (subscription, mode, selectedModel) => {
      expect(
        getEligiblePaidModelQualityRoute({
          mode,
          subscription,
          selectedModel,
        }),
      ).toBeUndefined();
    },
  );

  it.each([
    ["ask", "model-deepseek-v4-flash-0731", "test", "model-deepseek-v4-pro"],
    [
      "agent",
      "model-glm-5.3-flash-agent",
      "control",
      "model-glm-5.3-flash-agent",
    ],
    ["agent", "model-deepseek-v4-pro-0813", "test", "model-grok-4.6-pro"],
  ] as const)(
    "maps %s %s variant %s to %s",
    async (mode, selectedModel, variant, modelKey) => {
      const evaluateFlags = jest.fn(async () => ({ getFlag: () => variant }));

      await expect(
        evaluatePaidModelQualityExperiment({
          posthog: { evaluateFlags } as never,
          userId: "user-1",
          mode,
          subscription: "pro",
          selectedModel,
        }),
      ).resolves.toMatchObject({ variant, modelKey });
    },
  );

  it("evaluates only the flag for the resolved route", async () => {
    const evaluateFlags = jest.fn(async () => ({ getFlag: () => "control" }));

    await evaluatePaidModelQualityExperiment({
      posthog: { evaluateFlags } as never,
      userId: "user-1",
      mode: "agent",
      subscription: "pro-plus",
      selectedModel: "model-deepseek-v4-pro-0813",
    });

    expect(evaluateFlags).toHaveBeenCalledWith("user-1", {
      flagKeys: [PAID_PRO_MODEL_QUALITY_EXPERIMENT_KEY],
    });
  });

  it("fails closed for unknown values and evaluation errors", async () => {
    await expect(
      evaluatePaidModelQualityExperiment({
        posthog: {
          evaluateFlags: jest.fn(async () => ({ getFlag: () => true })),
        } as never,
        userId: "user-1",
        mode: "ask",
        subscription: "pro",
        selectedModel: "model-deepseek-v4-flash-0731",
      }),
    ).resolves.toBeUndefined();

    const warn = jest.spyOn(console, "warn").mockImplementation();
    await expect(
      evaluatePaidModelQualityExperiment({
        posthog: {
          evaluateFlags: jest.fn(async () => {
            throw new Error("unavailable");
          }),
        } as never,
        userId: "user-1",
        mode: "ask",
        subscription: "pro",
        selectedModel: "model-deepseek-v4-flash-0731",
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("drops attribution if a later limit-rescue route replaces the assignment", () => {
    const assignment = {
      key: PAID_STANDARD_MODEL_QUALITY_EXPERIMENT_KEY,
      route: "standard" as const,
      variant: "test" as const,
      controlModelKey: "model-glm-5.3-flash-agent" as const,
      modelKey: "model-deepseek-v4-pro" as const,
    };

    expect(
      getActivePaidModelQualityExperimentAssignment(
        assignment,
        "model-deepseek-v4-pro",
      ),
    ).toBe(assignment);
    expect(
      getActivePaidModelQualityExperimentAssignment(
        assignment,
        "agent-model-free",
      ),
    ).toBeUndefined();
    expect(getPaidModelQualityExperimentContext(assignment)).toEqual({
      key: PAID_STANDARD_MODEL_QUALITY_EXPERIMENT_KEY,
      variant: "test",
    });
  });

  it("captures a privacy-safe provider-boundary exposure", () => {
    const capture = jest.fn();
    const assignment = {
      key: PAID_STANDARD_MODEL_QUALITY_EXPERIMENT_KEY,
      route: "standard" as const,
      variant: "test" as const,
      controlModelKey: "model-glm-5.3-flash-agent" as const,
      modelKey: "model-deepseek-v4-pro" as const,
    };

    capturePaidModelQualityExperimentExposure({
      posthog: { capture } as never,
      userId: "user-1",
      subscription: "pro-plus",
      mode: "agent",
      selectedModelOverride: "hackerai-standard",
      selectedModel: assignment.modelKey,
      configuredModel: "deepseek/deepseek-v4-pro",
      assignment,
    });

    expect(capture).toHaveBeenCalledWith({
      distinctId: "user-1",
      event: PAID_MODEL_QUALITY_EXPOSURE_EVENT,
      properties: {
        experiment_key: PAID_STANDARD_MODEL_QUALITY_EXPERIMENT_KEY,
        experiment_variant: "test",
        [`$feature/${PAID_STANDARD_MODEL_QUALITY_EXPERIMENT_KEY}`]: "test",
        experiment_route: "standard",
        subscription: "pro-plus",
        subscription_tier: "pro-plus",
        mode: "agent",
        control_model: "model-glm-5.3-flash-agent",
        selected_model: "model-deepseek-v4-pro",
        selected_model_override: "hackerai-standard",
        configured_model: "deepseek/deepseek-v4-pro",
        exposure_surface: "provider_request",
        $process_person_profile: false,
      },
    });
  });

  it.each([
    ["ask", "success", "length", false, true],
    ["agent", "success", "stop", false, true],
    ["agent", "success", "length", true, false],
    ["agent", "error", "error", false, false],
  ] as const)(
    "classifies %s outcome=%s finish=%s stepLimit=%s as successful=%s",
    (mode, outcome, finishReason, stepLimitReached, successfulRun) => {
      const capture = jest.fn();

      capturePaidModelQualityRun({
        posthog: { capture } as never,
        userId: "user-1",
        experiment: {
          key: PAID_PRO_MODEL_QUALITY_EXPERIMENT_KEY,
          variant: "control",
        },
        subscription: "pro",
        mode,
        selectedModel: "model-deepseek-v4-pro-0813",
        configuredModel: "deepseek/deepseek-v4-pro-0813",
        responseModel: "deepseek/deepseek-v4-pro-0813",
        outcome,
        finishReason,
        fallbackServed: false,
        activeModelStreamDurationMs: 12_000,
        requestToFirstModelChunkMs: 800,
        providerRecoveryAttempts: 0,
        stepLimitReached,
      });

      expect(capture).toHaveBeenCalledWith({
        distinctId: "user-1",
        event: PAID_MODEL_QUALITY_RUN_EVENT,
        properties: expect.objectContaining({
          experiment_key: PAID_PRO_MODEL_QUALITY_EXPERIMENT_KEY,
          experiment_variant: "control",
          successful_run: successfulRun,
          outcome,
          mode,
        }),
      });
    },
  );
});
