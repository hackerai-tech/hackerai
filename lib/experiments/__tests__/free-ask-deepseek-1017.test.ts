import { myProvider } from "@/lib/ai/providers";
import {
  evaluateFlashRouting,
  createFlashRoutingExposureRecorder,
  getActiveFlashRoutingAssignment,
} from "../flash-routing";
import { FREE_ASK_DEEPSEEK_1017_KEY } from "../free-ask-deepseek-1017";
import { DEEPSEEK_1017_SLUG } from "../paid-deepseek-1017";

const freeAsk = {
  userId: "synthetic-user",
  subscription: "free" as const,
  mode: "ask" as const,
  selectedModel: "ask-model-free-glm",
  hasImages: false,
};
const flags = (variant: unknown, enabled = true) => ({
  getFeatureFlagResult: jest.fn(async () => ({ enabled, variant })),
  evaluateFlags: jest.fn(),
  capture: jest.fn(),
});

describe("Free Ask DeepSeek 1017", () => {
  it.each(["control", "test"] as const)(
    "uses the exact %s provider without treating assignment as exposure",
    async (variant) => {
      const posthog = flags(variant);
      const assignment = await evaluateFlashRouting({
        ...freeAsk,
        posthog: posthog as never,
      });
      expect(assignment).toMatchObject({
        key: FREE_ASK_DEEPSEEK_1017_KEY,
        variant,
        configuredModel:
          variant === "test" ? DEEPSEEK_1017_SLUG : "z-ai/glm-5.3-flash",
      });
      expect(myProvider.languageModel(assignment!.modelKey).modelId).toBe(
        assignment!.configuredModel,
      );
      expect(posthog.getFeatureFlagResult).toHaveBeenCalledWith(
        FREE_ASK_DEEPSEEK_1017_KEY,
        freeAsk.userId,
        {
          sendFeatureFlagEvents: false,
          personProperties: { subscription: "free", subscription_tier: "free" },
        },
      );
      expect(posthog.evaluateFlags).not.toHaveBeenCalled();
      const record = createFlashRoutingExposureRecorder({
        ...freeAsk,
        posthog: posthog as never,
        assignment,
        requestId: "synthetic-request",
      });
      record("deepseek-v4.1-flash-1017-cyber");
      expect(posthog.capture).not.toHaveBeenCalled();
      record(assignment!.configuredModel);
      record(assignment!.configuredModel);
      expect(posthog.capture).toHaveBeenCalledTimes(1);
      expect(posthog.capture.mock.calls[0][0].properties).toMatchObject({
        experiment_key: FREE_ASK_DEEPSEEK_1017_KEY,
        experiment_variant: variant,
        request_id: "synthetic-request",
        $insert_id: "synthetic-request:free-ask-1017-exposure",
      });
      expect(
        getActiveFlashRoutingAssignment(assignment, "model-abliterated", false),
      ).toBeUndefined();
      expect(
        getActiveFlashRoutingAssignment(assignment, assignment!.modelKey, true),
      ).toBeUndefined();
    },
  );

  it.each([
    { mode: "agent" as const },
    { subscription: "pro" as const },
    { selectedModel: "model-abliterated" },
    { modelPolicyActive: true },
    { limitRescue: true },
    { hasImages: true },
    { userId: "" },
  ])(
    "excludes competing policies and noneligible traffic: %j",
    async (scope) => {
      const posthog = flags("test");
      expect(
        await evaluateFlashRouting({
          ...freeAsk,
          ...scope,
          posthog: posthog as never,
        }),
      ).toBeUndefined();
      expect(posthog.getFeatureFlagResult).not.toHaveBeenCalled();
      expect(posthog.evaluateFlags).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, true, false, "unknown"])(
    "retains GLM for invalid flag %s",
    async (variant) => {
      expect(
        await evaluateFlashRouting({
          ...freeAsk,
          posthog: flags(variant) as never,
        }),
      ).toBeUndefined();
    },
  );

  it("restores the baseline when disabled or unavailable", async () => {
    expect(
      await evaluateFlashRouting({
        ...freeAsk,
        posthog: flags("test", false) as never,
      }),
    ).toBeUndefined();
    expect(
      await evaluateFlashRouting({ ...freeAsk, posthog: null }),
    ).toBeUndefined();
    const posthog = flags("test");
    posthog.getFeatureFlagResult.mockRejectedValue(new Error("offline"));
    expect(
      await evaluateFlashRouting({ ...freeAsk, posthog: posthog as never }),
    ).toBeUndefined();
  });
});
