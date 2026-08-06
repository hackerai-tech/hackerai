import { describe, expect, it, jest } from "@jest/globals";
import {
  KIMI_REASONING_EXPERIMENT_KEY,
  evaluateKimiReasoningExperiment,
  isEligibleForKimiReasoningExperiment,
} from "../kimi-reasoning";

const eligibleRequest = {
  userId: "user_123",
  subscription: "pro" as const,
  mode: "agent" as const,
  selectedModel: "model-opus-4.6",
  configuredModelId: "moonshotai/kimi-k3",
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

describe("Kimi reasoning experiment", () => {
  it("limits eligibility to paid individual Max Agent requests served by Kimi", () => {
    expect(isEligibleForKimiReasoningExperiment(eligibleRequest)).toBe(true);
    expect(
      isEligibleForKimiReasoningExperiment({
        ...eligibleRequest,
        selectedModel: "model-kimi-k3",
      }),
    ).toBe(true);
    expect(
      isEligibleForKimiReasoningExperiment({
        ...eligibleRequest,
        subscription: "free",
      }),
    ).toBe(false);
    expect(
      isEligibleForKimiReasoningExperiment({
        ...eligibleRequest,
        subscription: "team",
      }),
    ).toBe(false);
    expect(
      isEligibleForKimiReasoningExperiment({
        ...eligibleRequest,
        mode: "ask",
      }),
    ).toBe(false);
    expect(
      isEligibleForKimiReasoningExperiment({
        ...eligibleRequest,
        selectedModel: "agent-model",
      }),
    ).toBe(false);
    expect(
      isEligibleForKimiReasoningExperiment({
        ...eligibleRequest,
        configuredModelId: "x-ai/grok-4.5",
      }),
    ).toBe(false);
  });

  it.each([
    ["control", "high"],
    ["max", "max"],
  ] as const)(
    "maps the %s variant to %s reasoning",
    async (variant, effort) => {
      const { posthog, evaluateFlags, getFlag } = mockPostHogFlag(variant);

      await expect(
        evaluateKimiReasoningExperiment({
          posthog,
          ...eligibleRequest,
        }),
      ).resolves.toEqual({
        key: KIMI_REASONING_EXPERIMENT_KEY,
        variant,
        reasoningEffort: effort,
      });
      expect(evaluateFlags).toHaveBeenCalledWith("user_123", {
        flagKeys: [KIMI_REASONING_EXPERIMENT_KEY],
      });
      expect(getFlag).toHaveBeenCalledWith(KIMI_REASONING_EXPERIMENT_KEY);
    },
  );

  it.each([false, true, undefined, "unexpected"])(
    "keeps the existing high default without experiment context for %p",
    async (flagValue) => {
      const { posthog } = mockPostHogFlag(flagValue);
      await expect(
        evaluateKimiReasoningExperiment({
          posthog,
          ...eligibleRequest,
        }),
      ).resolves.toBeUndefined();
    },
  );

  it("does not evaluate flags for ineligible requests", async () => {
    const { posthog, evaluateFlags } = mockPostHogFlag("max");
    await expect(
      evaluateKimiReasoningExperiment({
        posthog,
        ...eligibleRequest,
        mode: "ask",
      }),
    ).resolves.toBeUndefined();
    expect(evaluateFlags).not.toHaveBeenCalled();
  });

  it("fails closed to the existing high default", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const posthog = {
      evaluateFlags: jest.fn(async () => {
        throw new Error("PostHog unavailable");
      }),
    } as any;

    try {
      await expect(
        evaluateKimiReasoningExperiment({
          posthog,
          ...eligibleRequest,
        }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "Kimi reasoning experiment evaluation failed",
        expect.objectContaining({
          flag_key: KIMI_REASONING_EXPERIMENT_KEY,
          error_name: "Error",
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
