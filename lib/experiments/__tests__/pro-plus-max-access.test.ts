import {
  evaluateProPlusMaxAccessExperiment,
  isEligibleForProPlusMaxAccessExperiment,
  PRO_PLUS_MAX_ACCESS_EXPERIMENT_KEY,
  PRO_PLUS_MAX_ACCESS_EXPOSURE_EVENT,
} from "../pro-plus-max-access";

describe("HAC-59 Pro+ included Max access experiment", () => {
  it("only enrolls Agent-mode Pro+ users without usable Extra Usage", () => {
    expect(
      isEligibleForProPlusMaxAccessExperiment({
        subscription: "pro-plus",
        mode: "agent",
        extraUsageAvailable: false,
      }),
    ).toBe(true);

    for (const subscription of ["free", "pro", "ultra", "team"] as const) {
      expect(
        isEligibleForProPlusMaxAccessExperiment({
          subscription,
          mode: "agent",
          extraUsageAvailable: false,
        }),
      ).toBe(false);
    }

    expect(
      isEligibleForProPlusMaxAccessExperiment({
        subscription: "pro-plus",
        mode: "ask",
        extraUsageAvailable: false,
      }),
    ).toBe(false);
    expect(
      isEligibleForProPlusMaxAccessExperiment({
        subscription: "pro-plus",
        mode: "agent",
        extraUsageAvailable: true,
      }),
    ).toBe(false);
  });

  it.each([
    ["control", false],
    ["included_max", true],
  ] as const)("maps %s to included access=%s", async (variant, included) => {
    const capture = jest.fn();
    const assignment = await evaluateProPlusMaxAccessExperiment({
      posthog: {
        evaluateFlags: jest.fn().mockResolvedValue({
          getFlag: jest.fn().mockReturnValue(variant),
        }),
        capture,
      } as never,
      userId: "user_123",
      subscription: "pro-plus",
      mode: "agent",
      extraUsageAvailable: false,
      captureExposure: true,
    });

    expect(assignment).toEqual({
      key: PRO_PLUS_MAX_ACCESS_EXPERIMENT_KEY,
      variant,
      includedMaxAccess: included,
    });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: "user_123",
        event: PRO_PLUS_MAX_ACCESS_EXPOSURE_EVENT,
        properties: expect.objectContaining({
          experiment_variant: variant,
          max_access_included: included,
          exposure_surface: "agent_model_selector",
        }),
      }),
    );
  });

  it("fails closed for missing flags, errors, and ineligible users", async () => {
    const evaluateFlags = jest
      .fn()
      .mockResolvedValueOnce({ getFlag: () => false })
      .mockRejectedValueOnce(new Error("PostHog unavailable"));
    const posthog = { evaluateFlags, capture: jest.fn() } as never;

    await expect(
      evaluateProPlusMaxAccessExperiment({
        posthog,
        userId: "user_123",
        subscription: "pro-plus",
        mode: "agent",
        extraUsageAvailable: false,
      }),
    ).resolves.toBeUndefined();
    await expect(
      evaluateProPlusMaxAccessExperiment({
        posthog,
        userId: "user_123",
        subscription: "pro-plus",
        mode: "agent",
        extraUsageAvailable: false,
      }),
    ).resolves.toBeUndefined();
    await expect(
      evaluateProPlusMaxAccessExperiment({
        posthog,
        userId: "user_123",
        subscription: "pro",
        mode: "agent",
        extraUsageAvailable: false,
      }),
    ).resolves.toBeUndefined();

    expect(evaluateFlags).toHaveBeenCalledTimes(2);
  });
});
