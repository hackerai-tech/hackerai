import {
  evaluateAbliteratedModel,
  ABLITERATED_EXPERIMENT_KEY,
} from "../abliterated-model";
import type { SelectedModel, SubscriptionTier } from "@/types";
import {
  ABLITERATION_MODEL_ID,
  ABLITERATION_MODEL_KEY,
  isAbliterationModel,
} from "@/lib/ai/abliteration";

describe("Abliteration model identity", () => {
  it("recognizes the internal route and provider model IDs", () => {
    expect(isAbliterationModel(ABLITERATION_MODEL_KEY)).toBe(true);
    expect(isAbliterationModel(ABLITERATION_MODEL_ID)).toBe(true);
    expect(isAbliterationModel("model-deepseek-v4-flash-0731")).toBe(false);
  });
});

describe("moderation-gated Abliteration assignment", () => {
  const originalKey = process.env.ABLITERATION_API_KEY;
  beforeEach(() => {
    process.env.ABLITERATION_API_KEY = "test-only-placeholder";
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.ABLITERATION_API_KEY;
    else process.env.ABLITERATION_API_KEY = originalKey;
  });
  const messages = [
    {
      id: "u",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "private test prompt" }],
    },
  ];
  const defaults = {
    userId: "u",
    subscription: "pro" as SubscriptionTier,
    selectedModel: "model-deepseek-v4-flash-0731",
    moderationEligible: true,
    messages,
  };
  it.each([undefined, "auto", "hackerai-standard"] as const)(
    "routes an eligible %s request only for an explicit test variant",
    async (selectedModelOverride) => {
      const getFeatureFlag = jest.fn().mockResolvedValue("test");
      const result = await evaluateAbliteratedModel({
        ...defaults,
        selectedModelOverride,
        posthog: { getFeatureFlag },
      });
      expect(result?.modelKey).toBe("model-abliterated");
      expect(getFeatureFlag).toHaveBeenCalledWith(
        ABLITERATED_EXPERIMENT_KEY,
        "u",
        {
          sendFeatureFlagEvents: false,
          personProperties: { subscription: "pro", subscription_tier: "pro" },
        },
      );
      expect(JSON.stringify(getFeatureFlag.mock.calls)).not.toContain(
        "private test prompt",
      );
    },
  );
  it.each([
    { subscription: "free" as SubscriptionTier },
    { moderationEligible: false },
    { limitRescue: true },
    { selectedModelOverride: "hackerai-pro" as SelectedModel },
    { selectedModelOverride: "hackerai-max" as SelectedModel },
    { messages: [] },
    {
      messages: [
        {
          id: "f",
          role: "user" as const,
          parts: [
            {
              type: "file" as const,
              mediaType: "application/pdf",
              url: "https://example.test/private.pdf",
            },
          ],
        },
      ],
    },
    {
      messages: [
        {
          id: "f",
          role: "user" as const,
          parts: [
            {
              type: "file" as const,
              mediaType: "image/png",
              url: "https://example.test/private.png",
            },
          ],
        },
      ],
    },
  ])("does not evaluate ineligible requests: %j", async (overrides) => {
    const getFeatureFlag = jest.fn().mockResolvedValue("test");
    expect(
      await evaluateAbliteratedModel({
        ...defaults,
        ...overrides,
        posthog: { getFeatureFlag },
      }),
    ).toBeUndefined();
    expect(getFeatureFlag).not.toHaveBeenCalled();
  });
  it.each([false, true, undefined, "unexpected"])(
    "fails closed on %s",
    async (value) => {
      expect(
        await evaluateAbliteratedModel({
          ...defaults,
          posthog: { getFeatureFlag: jest.fn().mockResolvedValue(value) },
        }),
      ).toBeUndefined();
    },
  );
  it("preserves Ultra Auto's baseline for controls", async () => {
    expect(
      await evaluateAbliteratedModel({
        ...defaults,
        subscription: "ultra",
        selectedModel: "model-deepseek-v4-pro-0813",
        posthog: { getFeatureFlag: jest.fn().mockResolvedValue("control") },
      }),
    ).toMatchObject({
      variant: "control",
      modelKey: "model-deepseek-v4-pro-0813",
    });
  });
  it("fails closed on missing configuration or lookup failure", async () => {
    const getFeatureFlag = jest.fn().mockRejectedValue(new Error("offline"));
    expect(
      await evaluateAbliteratedModel({
        ...defaults,
        posthog: { getFeatureFlag },
      }),
    ).toBeUndefined();
    getFeatureFlag.mockClear();
    delete process.env.ABLITERATION_API_KEY;
    expect(
      await evaluateAbliteratedModel({
        ...defaults,
        posthog: { getFeatureFlag },
      }),
    ).toBeUndefined();
    expect(getFeatureFlag).not.toHaveBeenCalled();
  });
});
