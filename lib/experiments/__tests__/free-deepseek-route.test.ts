import { describe, expect, it, jest } from "@jest/globals";
import {
  FREE_DEEPSEEK_ROUTE_EXPERIMENT_KEY,
  FREE_DEEPSEEK_ROUTE_EXPOSURE_EVENT,
  FREE_DEEPSEEK_ROUTE_FEATURE_PROPERTY,
  captureFreeDeepSeekRouteExperimentExposure,
  evaluateFreeDeepSeekRouteExperiment,
  isEligibleForFreeDeepSeekRouteExperiment,
} from "../free-deepseek-route";

const eligibleRequest = {
  userId: "user_123",
  subscription: "free" as const,
  mode: "ask" as const,
  selectedModel: "ask-model-free",
};

function mockPostHogFlag(value: unknown) {
  const getFlag = jest.fn(() => value);
  const evaluateFlags = jest.fn(async () => ({ getFlag }));
  return {
    posthog: { evaluateFlags } as any,
    evaluateFlags,
    getFlag,
  };
}

describe("free DeepSeek route experiment", () => {
  it("limits eligibility to free Ask and Agent auto routes", () => {
    expect(isEligibleForFreeDeepSeekRouteExperiment(eligibleRequest)).toBe(
      true,
    );
    expect(
      isEligibleForFreeDeepSeekRouteExperiment({
        ...eligibleRequest,
        mode: "agent",
        selectedModel: "agent-model-free",
      }),
    ).toBe(true);
    expect(
      isEligibleForFreeDeepSeekRouteExperiment({
        ...eligibleRequest,
        subscription: "pro",
      }),
    ).toBe(false);
    expect(
      isEligibleForFreeDeepSeekRouteExperiment({
        ...eligibleRequest,
        selectedModel: "model-deepseek-v4-pro",
      }),
    ).toBe(false);
  });

  it.each([
    ["current_0731_low", "ask", "deepseek/deepseek-v4-flash-0731", "low"],
    ["current_0731_low", "agent", "deepseek/deepseek-v4-flash-0731", "high"],
    ["control", "ask", "deepseek/deepseek-v4-flash", "high"],
    ["control", "agent", "deepseek/deepseek-v4-flash", "high"],
  ] as const)(
    "maps %s in %s to the intended route package",
    async (variant, mode, modelSlug, reasoningEffort) => {
      const { posthog } = mockPostHogFlag(variant);

      await expect(
        evaluateFreeDeepSeekRouteExperiment({
          posthog,
          ...eligibleRequest,
          mode,
          selectedModel: mode === "ask" ? "ask-model-free" : "agent-model-free",
        }),
      ).resolves.toEqual({
        key: FREE_DEEPSEEK_ROUTE_EXPERIMENT_KEY,
        variant,
        modelSlug,
        reasoningEffort,
      });
    },
  );

  it.each([false, true, undefined, "unexpected"])(
    "keeps the current route when the flag value is %p",
    async (flagValue) => {
      const { posthog } = mockPostHogFlag(flagValue);
      await expect(
        evaluateFreeDeepSeekRouteExperiment({
          posthog,
          ...eligibleRequest,
        }),
      ).resolves.toBeUndefined();
    },
  );

  it("does not evaluate flags for ineligible requests", async () => {
    const { posthog, evaluateFlags } = mockPostHogFlag("control");
    await expect(
      evaluateFreeDeepSeekRouteExperiment({
        posthog,
        ...eligibleRequest,
        subscription: "pro",
      }),
    ).resolves.toBeUndefined();
    expect(evaluateFlags).not.toHaveBeenCalled();
  });

  it("fails closed to the current route", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const posthog = {
      evaluateFlags: jest.fn(async () => {
        throw new Error("PostHog unavailable");
      }),
    } as any;

    try {
      await expect(
        evaluateFreeDeepSeekRouteExperiment({
          posthog,
          ...eligibleRequest,
        }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "Free DeepSeek route experiment evaluation failed",
        expect.objectContaining({
          flag_key: FREE_DEEPSEEK_ROUTE_EXPERIMENT_KEY,
          error_name: "Error",
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("emits exposure only after a provider response model is known", () => {
    const capture = jest.fn();
    const assignment = {
      key: FREE_DEEPSEEK_ROUTE_EXPERIMENT_KEY,
      variant: "control" as const,
      modelSlug: "deepseek/deepseek-v4-flash" as const,
      reasoningEffort: "high" as const,
    };

    captureFreeDeepSeekRouteExperimentExposure({
      posthog: { capture } as any,
      userId: "user_123",
      mode: "ask",
      assignment,
    });
    expect(capture).not.toHaveBeenCalled();

    captureFreeDeepSeekRouteExperimentExposure({
      posthog: { capture } as any,
      userId: "user_123",
      mode: "ask",
      assignment,
      responseModel: "deepseek/deepseek-v4-flash",
      fallbackServed: false,
    });
    expect(capture).toHaveBeenCalledWith({
      distinctId: "user_123",
      event: FREE_DEEPSEEK_ROUTE_EXPOSURE_EVENT,
      properties: expect.objectContaining({
        experiment_variant: "control",
        [FREE_DEEPSEEK_ROUTE_FEATURE_PROPERTY]: "control",
        assigned_variant: "previous_flash_high",
        route_package: "previous_flash_high",
        configured_model: "deepseek/deepseek-v4-flash",
        response_model: "deepseek/deepseek-v4-flash",
        reasoning_effort: "high",
        fallback_served: false,
      }),
    });
  });
});
