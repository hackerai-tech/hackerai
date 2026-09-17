import {
  createProPlusAutoExposureRecorder,
  evaluateProPlusAutoRouting,
  getActiveProPlusAutoRoutingAssignment,
  PRO_PLUS_AUTO_EXPOSURE_EVENT,
  PRO_PLUS_AUTO_ROUTING_KEY,
} from "../pro-plus-auto-routing";
import { selectModel } from "@/lib/chat/chat-processor";
import { myProvider } from "@/lib/ai/providers";
import { buildProviderOptions } from "@/lib/api/chat-stream-helpers";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";

const flagClient = (value: unknown) => ({
  evaluateFlags: jest.fn().mockResolvedValue({ getFlag: () => value }),
});
const eligible = {
  userId: "routing-test-user",
  subscription: "pro-plus" as const,
  selectedModelOverride: "auto" as const,
  selectedModel: "model-deepseek-v4-flash-0731" as const,
  hasImages: false,
  limitRescue: false,
};

describe("Pro Plus Auto rollout", () => {
  it.each(["ask", "agent"] as ChatMode[])(
    "uses V4.1 Flash for enabled %s Auto text and PDF requests",
    async (mode) => {
      for (const selectedModelOverride of [undefined, "auto"] as const) {
        for (const hasPdf of [false, true]) {
          const posthog = flagClient(true);
          const assignment = await evaluateProPlusAutoRouting({
            ...eligible,
            posthog: posthog as never,
            selectedModelOverride,
            selectedModel: selectModel(
              mode,
              "pro-plus",
              selectedModelOverride,
              false,
              hasPdf,
            ),
          });
          expect(assignment?.variant).toBe("test");
          expect(myProvider.languageModel(assignment!.modelKey).modelId).toBe(
            "deepseek/deepseek-v4.1-flash",
          );
          expect(
            buildProviderOptions(
              true,
              eligible.userId,
              assignment!.modelKey,
              mode,
            ),
          ).toMatchObject({ openrouter: { reasoning: { effort: "high" } } });
          expect(posthog.evaluateFlags).toHaveBeenCalledWith(eligible.userId, {
            flagKeys: [PRO_PLUS_AUTO_ROUTING_KEY],
            personProperties: { subscription_tier: "pro-plus" },
          });
        }
      }
    },
  );

  it.each(["free", "pro", "ultra", "team"] as SubscriptionTier[])(
    "does not evaluate or promote %s users",
    async (subscription) => {
      const posthog = flagClient(true);
      expect(
        await evaluateProPlusAutoRouting({
          ...eligible,
          posthog: posthog as never,
          subscription,
        }),
      ).toBeUndefined();
      expect(posthog.evaluateFlags).not.toHaveBeenCalled();
    },
  );

  it.each([
    "hackerai-standard",
    "hackerai-pro",
    "hackerai-max",
  ] as SelectedModel[])(
    "preserves explicit %s selection",
    async (selectedModelOverride) => {
      const posthog = flagClient(true);
      expect(
        await evaluateProPlusAutoRouting({
          ...eligible,
          posthog: posthog as never,
          selectedModelOverride,
        }),
      ).toBeUndefined();
      expect(posthog.evaluateFlags).not.toHaveBeenCalled();
    },
  );

  it("preserves images, allowance rescue, and models chosen by other gates", async () => {
    const posthog = flagClient(true);
    for (const overrides of [
      { hasImages: true },
      { limitRescue: true },
      { selectedModel: "model-glm-5.3-flash" as const },
      { selectedModel: "ask-model-free" as const },
      { userId: "" },
    ]) {
      expect(
        await evaluateProPlusAutoRouting({
          ...eligible,
          posthog: posthog as never,
          ...overrides,
        }),
      ).toBeUndefined();
    }
    expect(posthog.evaluateFlags).not.toHaveBeenCalled();
  });

  it("keeps Flash 0731 as the disabled control", async () => {
    const assignment = await evaluateProPlusAutoRouting({
      ...eligible,
      posthog: flagClient(false) as never,
    });
    expect(assignment).toMatchObject({
      variant: "control",
      modelKey: eligible.selectedModel,
    });
  });

  it.each([undefined, null, "test", 1])(
    "fails closed for an invalid flag value %s",
    async (value) => {
      expect(
        await evaluateProPlusAutoRouting({
          ...eligible,
          posthog: flagClient(value) as never,
        }),
      ).toBeUndefined();
    },
  );

  it("fails closed on unavailable analytics", async () => {
    expect(
      await evaluateProPlusAutoRouting({ ...eligible, posthog: null }),
    ).toBeUndefined();
    expect(
      await evaluateProPlusAutoRouting({
        ...eligible,
        posthog: {
          evaluateFlags: jest.fn().mockRejectedValue(new Error("offline")),
        } as never,
      }),
    ).toBeUndefined();
  });

  it("drops attribution superseded by routing or allowance rescue", async () => {
    const assignment = await evaluateProPlusAutoRouting({
      ...eligible,
      posthog: flagClient(true) as never,
    });
    expect(
      getActiveProPlusAutoRoutingAssignment(
        assignment,
        assignment!.modelKey,
        false,
      ),
    ).toBe(assignment);
    expect(
      getActiveProPlusAutoRoutingAssignment(
        assignment,
        eligible.selectedModel,
        false,
      ),
    ).toBeUndefined();
    expect(
      getActiveProPlusAutoRoutingAssignment(
        assignment,
        assignment!.modelKey,
        true,
      ),
    ).toBeUndefined();
  });

  it.each([false, true])(
    "records actual exposure once for enabled=%s",
    async (enabled) => {
      const assignment = await evaluateProPlusAutoRouting({
        ...eligible,
        posthog: flagClient(enabled) as never,
      });
      const capture = jest.fn();
      const record = createProPlusAutoExposureRecorder({
        posthog: { capture } as never,
        assignment,
        userId: eligible.userId,
        mode: "agent",
        requestId: "request-test",
      });
      expect(capture).not.toHaveBeenCalled();
      record("z-ai/glm-5.3-flash");
      expect(capture).not.toHaveBeenCalled();
      record(assignment!.configuredModel);
      record(assignment!.configuredModel);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledWith({
        distinctId: eligible.userId,
        event: PRO_PLUS_AUTO_EXPOSURE_EVENT,
        properties: expect.objectContaining({
          experiment_key: PRO_PLUS_AUTO_ROUTING_KEY,
          experiment_variant: enabled ? "test" : "control",
          [`$feature/${PRO_PLUS_AUTO_ROUTING_KEY}`]: enabled,
          configured_model: assignment!.configuredModel,
          subscription_tier: "pro-plus",
          exposure_surface: "provider_request",
          $process_person_profile: false,
        }),
      });
    },
  );

  it("does not expose inactive assignments or interrupt requests on capture failure", async () => {
    const capture = jest.fn().mockImplementation(() => {
      throw new Error("offline");
    });
    const args = {
      posthog: { capture } as never,
      userId: eligible.userId,
      mode: "ask" as const,
      requestId: "test",
    };
    createProPlusAutoExposureRecorder({ ...args, assignment: undefined })(
      "deepseek/deepseek-v4.1-flash",
    );
    expect(capture).not.toHaveBeenCalled();
    const assignment = await evaluateProPlusAutoRouting({
      ...eligible,
      posthog: flagClient(true) as never,
    });
    expect(() =>
      createProPlusAutoExposureRecorder({ ...args, assignment })(
        assignment!.configuredModel,
      ),
    ).not.toThrow();
  });
});
