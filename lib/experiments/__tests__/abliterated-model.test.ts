import { INFERENCE_CYBER_FLAG } from "@/lib/ai/inference";
import {
  evaluateAbliteratedModel,
  ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY,
} from "../abliterated-model";
import { ABLITERATION_MAX_IMAGES_PER_REQUEST } from "@/lib/ai/abliteration-media";
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
import {
  ABLITERATION_LARGE_FLASH_MODEL_ID,
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
    expect(isAbliterationModel(ABLITERATION_LARGE_FLASH_MODEL_ID)).toBe(true);
    expect(isAbliterationModel(ABLITERATION_LARGE_V2_MODEL_KEY)).toBe(true);
    expect(isAbliterationModel(ABLITERATION_LARGE_V2_MODEL_ID)).toBe(true);
    expect(isAbliterationModel("model-deepseek-v4-flash-0731")).toBe(false);
  });
});

describe("paid moderation-gated three-step Abliteration", () => {
  const originalKey = process.env.ABLITERATION_API_KEY;
  beforeEach(() => {
    jest.clearAllMocks();
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
    mode: "ask" as const,
    subscription: "pro" as SubscriptionTier,
    selectedModel: "model-deepseek-v4-flash-0731",
    moderationEligible: true,
    messages,
  };
  describe.each(["ask", "agent"] as const)("shipped %s default", (mode) => {
    it.each(["pro", "pro-plus", "ultra", "team"] as const)(
      "routes every eligible %s selector without any flag lookup",
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
            key: ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY,
            variant: "test",
            modelKey: ABLITERATION_MODEL_KEY,
            baselineModel: defaults.selectedModel,
            generationStepLimit: 3,
            selectionSource: "moderation",
            moderationChecked: true,
          });
          expect(getPostHogFlagWithoutExposure).not.toHaveBeenCalled();
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
    it.each([
      { limitRescue: true },
      { moderationEligible: false },
      { messages: [] },
      {
        messages: [
          {
            id: "pdf",
            role: "user" as const,
            parts: [
              {
                type: "file" as const,
                mediaType: "application/pdf",
                url: "https://example.test/test.pdf",
              },
            ],
          },
        ],
      },
    ])("preserves baseline for excluded input %j", async (overrides) => {
      await expect(
        evaluateAbliteratedModel({
          ...defaults,
          mode,
          ...overrides,
        }),
      ).resolves.toBeUndefined();
      expect(getPostHogFlagWithoutExposure).not.toHaveBeenCalled();
    });
    it("keeps the baseline when the provider credential is absent", async () => {
      delete process.env.ABLITERATION_API_KEY;
      await expect(
        evaluateAbliteratedModel({ ...defaults, mode }),
      ).resolves.toBeUndefined();
    });
  });
  it.each(
    [
      imageAttachmentMessages,
      imageViewMessages,
      imageAttachmentHistory(ABLITERATION_MAX_IMAGES_PER_REQUEST),
      imageAttachmentTurn(ABLITERATION_MAX_IMAGES_PER_REQUEST + 1),
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
        modelKey: ABLITERATION_MODEL_KEY,
        baselineModel: "model-grok-4.6",
      });
    },
  );
  it("diagnoses the default without customer content and without changing behavior on logging failure", async () => {
    const diagnosticContext = {
      chatId: "test-chat",
      requestId: "test-run",
      logAll: true,
    };
    const result = await evaluateAbliteratedModel({
      ...defaults,
      diagnosticContext,
    });
    expect(result?.key).toBe(
      ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY,
    );
    expect(phLogger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        reason: "moderated_three_step_default",
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
    ).resolves.toMatchObject({ modelKey: ABLITERATION_MODEL_KEY });
  });

  it.each(["pro", "pro-plus", "ultra", "team"] as const)(
    "keeps the baseline for a %s request below the moderation threshold",
    async (subscription) => {
      expect(
        await evaluateAbliteratedModel({
          ...defaults,
          subscription,
          moderationEligible: false,
          moderationChecked: true,
        }),
      ).toBeUndefined();
    },
  );
});

describe("Inference rollout assignment", () => {
  const originalInferenceKey = process.env.INFERENCE_API_KEY;
  const originalAbliterationKey = process.env.ABLITERATION_API_KEY;
  afterEach(() => {
    if (originalInferenceKey === undefined)
      delete process.env.INFERENCE_API_KEY;
    else process.env.INFERENCE_API_KEY = originalInferenceKey;
    if (originalAbliterationKey === undefined)
      delete process.env.ABLITERATION_API_KEY;
    else process.env.ABLITERATION_API_KEY = originalAbliterationKey;
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
    process.env.ABLITERATION_API_KEY = "test-only";
    jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue(true);
  });
  it("enables eligible Production and Preview requests", async () => {
    expect((await evaluate("preview"))?.inferenceCyberEnabled).toBe(true);
    expect((await evaluate("production"))?.inferenceCyberEnabled).toBe(true);
    expect(await evaluate("preview", "free")).toBeUndefined();
    expect(await evaluate("preview", "pro", "application/pdf")).toBeUndefined();
    expect(
      (await evaluate("preview", "pro", "image/png"))?.inferenceCyberEnabled,
    ).toBe(true);
  });
  it.each(["ask", "agent"] as const)(
    "assigns the new rollout in %s",
    async (mode) => {
      expect(
        await evaluate("production", "pro", undefined, { mode }),
      ).toMatchObject({
        key: INFERENCE_CYBER_FLAG,
        inferenceCyberEnabled: true,
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
  it("requires the retained fallback provider to be configured", async () => {
    delete process.env.ABLITERATION_API_KEY;
    expect(await evaluate("production")).toBeUndefined();
    expect(getPostHogFlagWithoutExposure).not.toHaveBeenCalled();
  });
  it("does not enable Inference outside a trusted deployed runtime", async () => {
    expect((await evaluate(undefined))?.inferenceCyberEnabled).toBe(false);
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
    "uses the shared moderation-gated route when Inference rollout is %s",
    async (value) => {
      jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue(value);
      expect(await evaluate("production")).toMatchObject({
        key: ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY,
        inferenceCyberEnabled: false,
      });
    },
  );
  it("retains Abliteration when key or flag is missing, false, or unavailable", async () => {
    delete process.env.INFERENCE_API_KEY;
    expect((await evaluate("preview"))?.inferenceCyberEnabled).toBe(false);
    process.env.INFERENCE_API_KEY = "test-only";
    jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue(false);
    expect((await evaluate("preview"))?.inferenceCyberEnabled).toBe(false);
    jest
      .mocked(getPostHogFlagWithoutExposure)
      .mockRejectedValue(new Error("unavailable"));
    expect((await evaluate("preview"))?.inferenceCyberEnabled).toBe(false);
  });
});
