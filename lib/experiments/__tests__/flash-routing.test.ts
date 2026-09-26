import {
  evaluateFlashRouting,
  getActiveFlashRoutingAssignment,
  createFlashRoutingExposureRecorder,
  PAID_AGENT_FLASH_RETURN_KEY,
  FREE_ASK_DEEPSEEK_V41_KEY,
  FLASH_ROUTING_EXPOSURE_EVENT,
} from "@/lib/experiments/flash-routing";

const free = {
  userId: "test-user",
  subscription: "free" as const,
  mode: "ask" as const,
  selectedModel: "ask-model-free-glm",
  hasImages: false,
};
const paid = {
  ...free,
  subscription: "pro" as const,
  mode: "agent" as const,
  selectedModel: "model-deepseek-v4-flash-0731",
};
const flags = (variant: unknown) => ({
  evaluateFlags: jest.fn(async () => ({ getFlag: () => variant })),
});

describe("Flash routing experiments", () => {
  it.each(["control", "test"] as const)(
    "routes free Ask %s and records only actual matching exposure",
    async (variant) => {
      const posthog = flags(variant);
      const assignment = await evaluateFlashRouting({
        ...free,
        posthog: posthog as never,
      });
      const configuredModel =
        variant === "control"
          ? "z-ai/glm-5.3-flash"
          : "deepseek/deepseek-v4.1-flash";
      expect(assignment).toEqual({
        key: FREE_ASK_DEEPSEEK_V41_KEY,
        variant,
        modelKey:
          variant === "control"
            ? "ask-model-free-glm"
            : "ask-model-free-deepseek-v41",
        configuredModel,
      });
      expect(posthog.evaluateFlags).toHaveBeenCalledWith("test-user", {
        flagKeys: [FREE_ASK_DEEPSEEK_V41_KEY],
      });
      const capture = jest.fn();
      const record = createFlashRoutingExposureRecorder({
        ...free,
        posthog: { capture },
        assignment,
        requestId: "free-request",
      });
      record("deepseek/deepseek-v4-flash-0731");
      expect(capture).not.toHaveBeenCalled();
      record(configuredModel);
      record(configuredModel);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledWith(
        expect.objectContaining({
          distinctId: "test-user",
          event: FLASH_ROUTING_EXPOSURE_EVENT,
          properties: expect.objectContaining({
            experiment_key: FREE_ASK_DEEPSEEK_V41_KEY,
            [`$feature/${FREE_ASK_DEEPSEEK_V41_KEY}`]: variant,
            mode: "ask",
            subscription: "free",
            configured_model: configuredModel,
          }),
        }),
      );
      expect(
        getActiveFlashRoutingAssignment(assignment, assignment!.modelKey, true),
      ).toBeUndefined();
    },
  );
  it.each([
    [
      paid,
      "control",
      PAID_AGENT_FLASH_RETURN_KEY,
      "model-deepseek-v4-flash-0731",
    ],
    [paid, "test", PAID_AGENT_FLASH_RETURN_KEY, "model-glm-5.3-flash-agent"],
  ] as const)(
    "routes only the assigned eligible variant",
    async (scope, variant, key, modelKey) => {
      const posthog = flags(variant);
      const result = await evaluateFlashRouting({
        ...scope,
        posthog: posthog as never,
      });
      expect(result).toEqual({
        key,
        variant,
        modelKey,
        configuredModel:
          variant === "test"
            ? "z-ai/glm-5.3-flash"
            : "deepseek/deepseek-v4-flash-0731",
      });
      expect(posthog.evaluateFlags).toHaveBeenCalledWith("test-user", {
        flagKeys: [key],
      });
    },
  );

  it.each([
    { ...free, mode: "agent" as const },
    { ...free, subscription: "pro" as const },
    { ...free, selectedModel: "ask-model-free" },
    { ...paid, mode: "ask" as const },
    { ...paid, subscription: "free" as const },
    { ...paid, selectedModel: "model-deepseek-v4-pro-0813" },
    { ...paid, selectedModel: "model-glm-5.3-flash-agent" },
    { ...paid, mode: "ask" as const, selectedModel: "model-glm-5.3-flash" },
    { ...paid, selectedModel: "model-opus-4.6" },
    { ...paid, selectedModel: "model-deepseek-v4-flash-vision" },
    { ...paid, hasImages: true },
    { ...free, hasImages: true },
    { ...free, userId: "" },
    { ...free, selectedModel: "model-glm-5.3-flash" },
  ])("does not evaluate excluded requests: %j", async (scope) => {
    const posthog = flags("test");
    expect(
      await evaluateFlashRouting({ ...scope, posthog: posthog as never }),
    ).toBeUndefined();
    expect(posthog.evaluateFlags).not.toHaveBeenCalled();
  });

  it.each([true, false, undefined, "unknown"])(
    "retains current behavior for %s",
    async (variant) => {
      for (const scope of [free, paid]) {
        expect(
          await evaluateFlashRouting({
            ...scope,
            posthog: flags(variant) as never,
          }),
        ).toBeUndefined();
      }
    },
  );

  it("fails closed on missing client or flag service failure", async () => {
    expect(
      await evaluateFlashRouting({ ...paid, posthog: null }),
    ).toBeUndefined();
    expect(
      await evaluateFlashRouting({
        ...paid,
        posthog: {
          evaluateFlags: jest.fn().mockRejectedValue(new Error("unavailable")),
        } as never,
      }),
    ).toBeUndefined();
  });

  it.each(["control", "test"])(
    "excludes rescue and rerouted requests even for %s",
    async (variant) => {
      const assignment = await evaluateFlashRouting({
        ...paid,
        posthog: flags(variant) as never,
      });
      expect(
        getActiveFlashRoutingAssignment(
          assignment,
          assignment!.modelKey,
          false,
        ),
      ).toBe(assignment);
      expect(
        getActiveFlashRoutingAssignment(assignment, assignment!.modelKey, true),
      ).toBeUndefined();
      expect(
        getActiveFlashRoutingAssignment(
          assignment,
          "model-deepseek-v4-flash-vision",
          false,
        ),
      ).toBeUndefined();
    },
  );

  it("records only the first matching provider request, with an explicit property allowlist", async () => {
    const assignment = await evaluateFlashRouting({
      ...paid,
      posthog: flags("test") as never,
    });
    const capture = jest.fn();
    const record = createFlashRoutingExposureRecorder({
      ...paid,
      posthog: { capture } as never,
      assignment,
      requestId: "request-1",
    });
    expect(capture).not.toHaveBeenCalled();
    record("deepseek/deepseek-v4.1-flash");
    expect(capture).not.toHaveBeenCalled();
    record("z-ai/glm-5.3-flash");
    record("z-ai/glm-5.3-flash");
    record("deepseek/deepseek-v4-flash-0731");
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith({
      distinctId: "test-user",
      event: FLASH_ROUTING_EXPOSURE_EVENT,
      properties: {
        experiment_key: PAID_AGENT_FLASH_RETURN_KEY,
        experiment_variant: "test",
        [`$feature/${PAID_AGENT_FLASH_RETURN_KEY}`]: "test",
        subscription: "pro",
        subscription_tier: "pro",
        mode: "agent",
        selected_model: "model-glm-5.3-flash-agent",
        configured_model: "z-ai/glm-5.3-flash",
        request_id: "request-1",
        exposure_surface: "provider_request",
        $process_person_profile: false,
      },
    });
  });

  it("does not fail generation when capture throws", async () => {
    const assignment = await evaluateFlashRouting({
      ...paid,
      posthog: flags("test") as never,
    });
    const record = createFlashRoutingExposureRecorder({
      ...paid,
      assignment,
      requestId: "request-1",
      posthog: {
        capture: () => {
          throw new Error("unavailable");
        },
      } as never,
    });
    expect(() => record("z-ai/glm-5.3-flash")).not.toThrow();
  });
});
