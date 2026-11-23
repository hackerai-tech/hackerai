import {
  INFERENCE_CYBER_FLAG,
  INFERENCE_CYBER_MODEL_KEY,
  INFERENCE_MAX_IMAGES_PER_REQUEST,
} from "@/lib/ai/inference";
import { evaluateAbliteratedModel } from "../abliterated-model";
import type { UIMessage } from "ai";
import type { SubscriptionTier } from "@/types";
import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";

jest.mock("@/lib/posthog/flag-assignment", () => ({
  getPostHogFlagWithoutExposure: jest.fn(),
}));
import { phLogger } from "@/lib/posthog/server";

jest.mock("@/lib/posthog/server", () => ({
  phLogger: { info: jest.fn(), warn: jest.fn() },
}));

describe("paid moderation-gated three-step Inference route", () => {
  const originalInferenceKey = process.env.INFERENCE_API_KEY;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.INFERENCE_API_KEY = "test-only-placeholder";
    jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue(true);
  });
  afterAll(() => {
    if (originalInferenceKey === undefined)
      delete process.env.INFERENCE_API_KEY;
    else process.env.INFERENCE_API_KEY = originalInferenceKey;
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
    posthog: { getFeatureFlagResult: jest.fn() } as never,
    inferenceEnvironment: "production" as const,
    userId: "u",
    mode: "ask" as const,
    subscription: "pro" as SubscriptionTier,
    selectedModel: "model-deepseek-v4-flash-0731",
    moderationEligible: true,
    messages,
  };
  describe.each(["ask", "agent"] as const)("%s assignment", (mode) => {
    it.each(["pro", "pro-plus", "ultra", "team"] as const)(
      "routes every eligible %s selector to Inference",
      async (subscription) => {
        for (const selectedModelOverride of [
          undefined,
          "auto",
          "hackerai-standard",
          "hackerai-pro",
          "hackerai-max",
        ] as const) {
          const assignment = await evaluateAbliteratedModel({
            ...defaults,
            mode,
            subscription,
            selectedModelOverride,
          });
          expect(assignment).toMatchObject({
            key: INFERENCE_CYBER_FLAG,
            variant: "test",
            modelKey: INFERENCE_CYBER_MODEL_KEY,
            baselineModel: defaults.selectedModel,
            generationStepLimit: 3,
            selectionSource: "moderation",
            moderationChecked: true,
          });
        }
      },
    );
    it("excludes Free users for every selector even when moderation is eligible", async () => {
      for (const selectedModelOverride of [
        undefined,
        "auto",
        "hackerai-standard",
        "hackerai-pro",
        "hackerai-max",
      ] as const) {
        await expect(
          evaluateAbliteratedModel({
            ...defaults,
            mode,
            subscription: "free",
            selectedModelOverride,
            diagnosticContext: {
              chatId: "free-chat",
              requestId: "free-run",
              logAll: true,
            },
          }),
        ).resolves.toBeUndefined();
      }
      expect(getPostHogFlagWithoutExposure).not.toHaveBeenCalled();
      expect(phLogger.info).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          reason: "free_user",
          subscription_tier: "free",
        }),
      );
    });
  });
  it.each(
    [
      imageAttachmentMessages,
      imageViewMessages,
      imageAttachmentHistory(INFERENCE_MAX_IMAGES_PER_REQUEST),
      imageAttachmentTurn(INFERENCE_MAX_IMAGES_PER_REQUEST + 1),
    ].map((messages) => [messages]),
  )(
    "retains base-model vision routing and preprocessing eligibility",
    async (messages) => {
      await expect(
        evaluateAbliteratedModel({
          ...defaults,
          messages,
          selectedModel: "model-grok-4.6",
        }),
      ).resolves.toMatchObject({
        modelKey: INFERENCE_CYBER_MODEL_KEY,
        baselineModel: "model-grok-4.6",
      });
    },
  );
  it("diagnoses the assignment without customer content and without changing behavior on logging failure", async () => {
    const diagnosticContext = {
      chatId: "test-chat",
      requestId: "test-run",
      logAll: true,
    };
    const result = await evaluateAbliteratedModel({
      ...defaults,
      diagnosticContext,
    });
    expect(result?.key).toBe(INFERENCE_CYBER_FLAG);
    expect(phLogger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        reason: "inference_cyber_rollout",
        moderation_checked: true,
      }),
    );
    expect(JSON.stringify(jest.mocked(phLogger.info).mock.calls)).not.toContain(
      "private test prompt",
    );
    jest.mocked(phLogger.info).mockImplementationOnce(() => {
      throw new Error("logging unavailable");
    });
    await expect(
      evaluateAbliteratedModel({
        ...defaults,
        diagnosticContext,
      }),
    ).resolves.toMatchObject({ modelKey: INFERENCE_CYBER_MODEL_KEY });
  });
});

describe("Inference rollout assignment", () => {
  const originalInferenceKey = process.env.INFERENCE_API_KEY;
  afterEach(() => {
    if (originalInferenceKey === undefined)
      delete process.env.INFERENCE_API_KEY;
    else process.env.INFERENCE_API_KEY = originalInferenceKey;
  });
  const evaluate = (
    inferenceEnvironment: "preview" | "production" | undefined,
    subscription: SubscriptionTier = "pro",
    fileType?: string,
    overrides: Partial<Parameters<typeof evaluateAbliteratedModel>[0]> = {},
  ) =>
    evaluateAbliteratedModel({
      posthog: { getFeatureFlagResult: jest.fn() } as never,
      userId: "test-user",
      selectedModel: "model-glm-5.3",
      subscription,
      mode: "ask",
      inferenceEnvironment,
      moderationEligible: true,
      messages: [
        {
          id: "u",
          role: "user",
          parts: fileType
            ? [
                {
                  type: "file",
                  mediaType: fileType,
                  url: "https://example.test/file",
                },
              ]
            : [{ type: "text", text: "synthetic" }],
        },
      ],
      ...overrides,
    });
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.INFERENCE_API_KEY = "test-only";
    jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue(true);
  });
  it("enables eligible Production and Preview requests", async () => {
    expect((await evaluate("preview"))?.modelKey).toBe(
      INFERENCE_CYBER_MODEL_KEY,
    );
    expect((await evaluate("production"))?.modelKey).toBe(
      INFERENCE_CYBER_MODEL_KEY,
    );
    expect(await evaluate("preview", "free")).toBeUndefined();
    expect(await evaluate("preview", "pro", "application/pdf")).toBeUndefined();
    expect((await evaluate("preview", "pro", "image/png"))?.modelKey).toBe(
      INFERENCE_CYBER_MODEL_KEY,
    );
  });
  it.each(["ask", "agent"] as const)(
    "assigns the new rollout in %s",
    async (mode) => {
      expect(
        await evaluate("production", "pro", undefined, { mode }),
      ).toMatchObject({
        key: INFERENCE_CYBER_FLAG,
        modelKey: INFERENCE_CYBER_MODEL_KEY,
        generationStepLimit: 3,
      });
    },
  );
  it.each([
    { limitRescue: true },
    { moderationEligible: false },
    {
      moderationEligible: false,
      moderationChecked: false,
    },
    { messages: [] },
  ])("preserves eligibility gates: %j", async (overrides) => {
    expect(
      await evaluate("production", "pro", undefined, overrides),
    ).toBeUndefined();
    expect(getPostHogFlagWithoutExposure).not.toHaveBeenCalled();
  });
  it("does not enable Inference outside a trusted deployed runtime", async () => {
    expect(await evaluate(undefined)).toBeUndefined();
    expect(getPostHogFlagWithoutExposure).not.toHaveBeenCalled();
  });
  it.each(["pro", "pro-plus", "ultra", "team"] as const)(
    "keeps the baseline for below-threshold %s requests even when Inference is enabled",
    async (subscription) => {
      expect(
        await evaluate("production", subscription, undefined, {
          moderationEligible: false,
          moderationChecked: true,
        }),
      ).toBeUndefined();
      expect(getPostHogFlagWithoutExposure).not.toHaveBeenCalled();
    },
  );
  it.each([false, undefined, "test"])(
    "keeps the selected model when the Inference rollout is %s",
    async (value) => {
      jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue(value);
      expect(await evaluate("production")).toBeUndefined();
    },
  );
  it("keeps the selected model when the key is missing or the flag is unavailable", async () => {
    delete process.env.INFERENCE_API_KEY;
    expect(await evaluate("preview")).toBeUndefined();
    expect(getPostHogFlagWithoutExposure).not.toHaveBeenCalled();
    process.env.INFERENCE_API_KEY = "test-only";
    jest
      .mocked(getPostHogFlagWithoutExposure)
      .mockRejectedValue(new Error("unavailable"));
    expect(await evaluate("preview")).toBeUndefined();
  });
});
