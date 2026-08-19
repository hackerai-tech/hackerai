import {
  captureProPlusUltraDeepSeekProDefaultExposure,
  evaluateProPlusUltraDeepSeekProDefault,
  getActiveProPlusUltraDeepSeekProDefaultAssignment,
  getProPlusUltraDeepSeekProDefaultContext,
  isEligibleForProPlusUltraDeepSeekProDefault,
  PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_EXPERIMENT_KEY,
  PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_EXPOSURE_EVENT,
  PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_FEATURE_PROPERTY,
} from "@/lib/experiments/pro-plus-ultra-deepseek-pro-default";

describe("Pro Plus and Ultra DeepSeek Pro default experiment", () => {
  it.each(["pro-plus", "ultra"] as const)(
    "makes %s Auto text requests eligible",
    (subscription) => {
      expect(
        isEligibleForProPlusUltraDeepSeekProDefault({
          subscription,
          selectedModelOverride: "auto",
          hasImageAttachment: false,
        }),
      ).toBe(true);
    },
  );

  it.each([
    ["pro", "auto", false],
    ["team", "auto", false],
    ["pro-plus", "hackerai-standard", false],
    ["pro-plus", "hackerai-pro", false],
    ["ultra", "hackerai-max", false],
    ["ultra", "auto", true],
  ] as const)(
    "rejects plan %s, override %s, image=%s",
    (subscription, selectedModelOverride, hasImageAttachment) => {
      expect(
        isEligibleForProPlusUltraDeepSeekProDefault({
          subscription,
          selectedModelOverride,
          hasImageAttachment,
        }),
      ).toBe(false);
    },
  );

  it.each([
    ["control", "model-deepseek-v4-flash-0731"],
    ["deepseek_pro", "model-deepseek-v4-pro-0813"],
  ] as const)("maps %s to %s", async (variant, modelKey) => {
    const evaluateFlags = jest.fn(async () => ({ getFlag: () => variant }));

    await expect(
      evaluateProPlusUltraDeepSeekProDefault({
        posthog: { evaluateFlags } as never,
        userId: "user-1",
        subscription: "pro-plus",
        selectedModelOverride: "auto",
        hasImageAttachment: false,
      }),
    ).resolves.toEqual({
      key: PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_EXPERIMENT_KEY,
      variant,
      modelKey,
    });
  });

  it("does not evaluate ineligible requests", async () => {
    const evaluateFlags = jest.fn();

    await expect(
      evaluateProPlusUltraDeepSeekProDefault({
        posthog: { evaluateFlags } as never,
        userId: "user-1",
        subscription: "pro",
        selectedModelOverride: "auto",
        hasImageAttachment: false,
      }),
    ).resolves.toBeUndefined();
    expect(evaluateFlags).not.toHaveBeenCalled();
  });

  it("fails closed for unknown variants and evaluation errors", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      evaluateProPlusUltraDeepSeekProDefault({
        posthog: {
          evaluateFlags: jest.fn(async () => ({ getFlag: () => true })),
        } as never,
        userId: "user-1",
        subscription: "ultra",
        hasImageAttachment: false,
      }),
    ).resolves.toBeUndefined();

    await expect(
      evaluateProPlusUltraDeepSeekProDefault({
        posthog: {
          evaluateFlags: jest.fn(async () => {
            throw new Error("PostHog unavailable");
          }),
        } as never,
        userId: "user-1",
        subscription: "ultra",
        hasImageAttachment: false,
        requestId: "request-1",
      }),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain(
      '"event":"pro_plus_ultra_deepseek_pro_default_evaluation_failed"',
    );
    expect(warnSpy.mock.calls[0][0]).toContain('"request_id":"request-1"');
    warnSpy.mockRestore();
  });

  it("captures a content-free exposure at the provider request boundary", () => {
    const capture = jest.fn();
    const assignment = {
      key: PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_EXPERIMENT_KEY,
      variant: "deepseek_pro" as const,
      modelKey: "model-deepseek-v4-pro-0813" as const,
    };

    captureProPlusUltraDeepSeekProDefaultExposure({
      posthog: { capture } as never,
      userId: "user-1",
      subscription: "ultra",
      mode: "agent",
      endpoint: "/api/agent-long",
      selectedModelOverride: "auto",
      selectedModel: assignment.modelKey,
      configuredModel: "deepseek/deepseek-v4-pro-0813",
      chatId: "chat-1",
      triggerRunId: "run-1",
      assignment,
    });

    expect(capture).toHaveBeenCalledWith({
      distinctId: "user-1",
      event: PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_EXPOSURE_EVENT,
      properties: {
        experiment_key: PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_EXPERIMENT_KEY,
        experiment_variant: "deepseek_pro",
        [PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_FEATURE_PROPERTY]: "deepseek_pro",
        subscription: "ultra",
        subscription_tier: "ultra",
        mode: "agent",
        endpoint: "/api/agent-long",
        selected_model: "model-deepseek-v4-pro-0813",
        selected_model_override: "auto",
        configured_model: "deepseek/deepseek-v4-pro-0813",
        exposure_surface: "provider_request",
        chat_id: "chat-1",
        trigger_run_id: "run-1",
        $process_person_profile: false,
      },
    });
    expect(getProPlusUltraDeepSeekProDefaultContext(assignment)).toEqual({
      key: PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_EXPERIMENT_KEY,
      variant: "deepseek_pro",
    });
    expect(
      getActiveProPlusUltraDeepSeekProDefaultAssignment(
        assignment,
        "model-deepseek-v4-pro-0813",
      ),
    ).toBe(assignment);
    expect(
      getActiveProPlusUltraDeepSeekProDefaultAssignment(
        assignment,
        "model-deepseek-v4-flash-0731",
      ),
    ).toBeUndefined();
  });
});
