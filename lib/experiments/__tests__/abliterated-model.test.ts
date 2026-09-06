import {
  evaluateAbliteratedModel,
  ABLITERATED_EXPERIMENT_KEY,
} from "../abliterated-model";
import { ABLITERATION_MAX_IMAGES_PER_REQUEST } from "@/lib/ai/abliteration-media";
import type { UIMessage } from "ai";
import type { SelectedModel, SubscriptionTier } from "@/types";
import {
  ABLITERATION_MODEL_ID,
  ABLITERATION_MODEL_KEY,
  ABLITERATION_LARGE_V2_MODEL_ID,
  ABLITERATION_LARGE_V2_MODEL_KEY,
  isAbliterationModel,
} from "@/lib/ai/abliteration";

describe("Abliteration model identity", () => {
  it("recognizes the internal route and provider model IDs", () => {
    expect(isAbliterationModel(ABLITERATION_MODEL_KEY)).toBe(true);
    expect(isAbliterationModel(ABLITERATION_MODEL_ID)).toBe(true);
    expect(isAbliterationModel(ABLITERATION_LARGE_V2_MODEL_KEY)).toBe(true);
    expect(isAbliterationModel(ABLITERATION_LARGE_V2_MODEL_ID)).toBe(true);
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
  const imageAttachmentMessages = [
    {
      id: "image-attachment",
      role: "user" as const,
      parts: [
        {
          type: "file",
          mediaType: "image/png",
          url: "https://example.test/private.png",
        },
      ],
    },
  ] as unknown as UIMessage[];
  const imageViewMessages = [
    {
      id: "image-view",
      role: "assistant" as const,
      parts: [
        {
          type: "tool-file",
          toolCallId: "call-file-1",
          state: "output-available",
          output: {
            action: "view",
            kind: "image",
            mediaType: "image/png",
          },
        },
      ],
    },
  ] as unknown as UIMessage[];
  const imageAttachmentHistory = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `image-attachment-${index}`,
      role: "user" as const,
      parts: [
        {
          type: "file",
          mediaType: "image/png",
          url: `https://example.test/private-${index}.png`,
        },
      ],
    })) as unknown as UIMessage[];
  const imageAttachmentTurn = (count: number) =>
    [
      {
        id: "image-attachment-turn",
        role: "user" as const,
        parts: imageAttachmentHistory(count).flatMap((message) =>
          message.parts.map((part) => ({ ...part })),
        ),
      },
    ] as unknown as UIMessage[];
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
      expect(result).toMatchObject({
        modelKey: "model-abliterated",
      });
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
  it("keeps a request at the Abliteration image limit eligible", async () => {
    const getFeatureFlag = jest.fn().mockResolvedValue("test");

    await expect(
      evaluateAbliteratedModel({
        ...defaults,
        messages: imageAttachmentHistory(ABLITERATION_MAX_IMAGES_PER_REQUEST),
        posthog: { getFeatureFlag },
      }),
    ).resolves.toMatchObject({ modelKey: ABLITERATION_MODEL_KEY });
    expect(getFeatureFlag).toHaveBeenCalledTimes(1);
  });
  it("bypasses Abliteration when request history exceeds its image limit", async () => {
    const getFeatureFlag = jest.fn().mockResolvedValue("test");

    await expect(
      evaluateAbliteratedModel({
        ...defaults,
        messages: imageAttachmentTurn(ABLITERATION_MAX_IMAGES_PER_REQUEST + 1),
        posthog: { getFeatureFlag },
      }),
    ).resolves.toBeUndefined();
    expect(getFeatureFlag).not.toHaveBeenCalled();
  });
  it("applies the image limit across messages, not per turn", async () => {
    const getFeatureFlag = jest.fn().mockResolvedValue("test");
    const messages = imageAttachmentHistory(
      ABLITERATION_MAX_IMAGES_PER_REQUEST,
    );
    messages.push({
      id: "combined-image-turn",
      role: "user",
      parts: [
        { type: "text", text: "Inspect the full image history" },
        {
          type: "file",
          mediaType: "image/jpeg",
          url: "https://example.test/final-private.jpg",
        },
      ],
    } as unknown as UIMessage);

    await expect(
      evaluateAbliteratedModel({
        ...defaults,
        messages,
        posthog: { getFeatureFlag },
      }),
    ).resolves.toBeUndefined();
    expect(getFeatureFlag).not.toHaveBeenCalled();
  });
  it.each([
    {
      name: "explicit Pro",
      selectedModelOverride: "hackerai-pro" as SelectedModel,
      selectedModel: "model-deepseek-v4-pro-0813" as const,
    },
    {
      name: "explicit Max",
      selectedModelOverride: "hackerai-max" as SelectedModel,
      selectedModel: "model-grok-4.6" as const,
    },
    {
      name: "Ultra Ask Auto",
      selectedModelOverride: "auto" as SelectedModel,
      selectedModel: "model-deepseek-v4-pro-0813" as const,
      subscription: "ultra" as SubscriptionTier,
    },
  ])("routes $name to Large v2 in treatment", async (overrides) => {
    expect(
      await evaluateAbliteratedModel({
        ...defaults,
        ...overrides,
        posthog: { getFeatureFlag: jest.fn().mockResolvedValue("test") },
      }),
    ).toMatchObject({
      variant: "test",
      modelKey: ABLITERATION_LARGE_V2_MODEL_KEY,
      baselineModel: overrides.selectedModel,
    });
  });

  it.each([
    {
      name: "Pro image attachment",
      selectedModelOverride: "hackerai-pro" as SelectedModel,
      selectedModel: "model-deepseek-v4-pro-0813" as const,
      messages: imageAttachmentMessages,
    },
    {
      name: "Pro image-view tool result",
      selectedModelOverride: "hackerai-pro" as SelectedModel,
      selectedModel: "model-deepseek-v4-pro-0813" as const,
      messages: imageViewMessages,
    },
    {
      name: "Max image attachment",
      selectedModelOverride: "hackerai-max" as SelectedModel,
      selectedModel: "model-grok-4.6" as const,
      messages: imageAttachmentMessages,
    },
    {
      name: "Max image-view tool result",
      selectedModelOverride: "hackerai-max" as SelectedModel,
      selectedModel: "model-grok-4.6" as const,
      messages: imageViewMessages,
    },
  ])(
    "routes $name requests to the vision-capable base model",
    async ({ messages, selectedModel, selectedModelOverride }) => {
      expect(
        await evaluateAbliteratedModel({
          ...defaults,
          selectedModelOverride,
          selectedModel,
          messages,
          posthog: { getFeatureFlag: jest.fn().mockResolvedValue("test") },
        }),
      ).toMatchObject({
        variant: "test",
        modelKey: ABLITERATION_MODEL_KEY,
        baselineModel: selectedModel,
      });
    },
  );

  it("keeps Ultra Agent Auto on the base Abliteration route", async () => {
    expect(
      await evaluateAbliteratedModel({
        ...defaults,
        subscription: "ultra",
        selectedModelOverride: "auto",
        posthog: { getFeatureFlag: jest.fn().mockResolvedValue("test") },
      }),
    ).toMatchObject({ modelKey: ABLITERATION_MODEL_KEY });
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
