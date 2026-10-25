import {
  evaluateAbliteratedModel,
  ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY,
  ABLITERATED_SHORT_FOLLOWUP_KEY,
} from "../abliterated-model";
import { resolveAbliterationModelForGenerationStep } from "../abliterated-model-steps";
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

  describe("bounded same-chat follow-up", () => {
    const shortFollowup = [
      {
        id: "followup",
        role: "user" as const,
        parts: [
          {
            type: "text" as const,
            text: "Why did you stop helping with this authorized test?",
          },
        ],
      },
    ];
    const continuity = {
      ...defaults,
      posthog: {} as any,
      moderationEligible: false,
      allowsAbliterationContinuation: true,
      independentAbliterationSeedCount: 2,
      continuationTurn: true,
      messages: shortFollowup,
    };

    it.each(["ask", "agent"] as const)(
      "uses same-chat preference on %s without timestamps and returns to baseline on step two",
      async (mode) => {
        jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue("test");
        const assignment = await evaluateAbliteratedModel({
          ...continuity,
          mode,
        });
        expect(assignment).toMatchObject({
          key: ABLITERATED_SHORT_FOLLOWUP_KEY,
          modelKey: ABLITERATION_MODEL_KEY,
          baselineModel: defaults.selectedModel,
          generationStepLimit: 1,
          selectionSource: "history",
        });
        expect(getPostHogFlagWithoutExposure).toHaveBeenCalledWith(
          expect.anything(),
          ABLITERATED_SHORT_FOLLOWUP_KEY,
          "u",
          expect.objectContaining({ subscription_tier: "pro" }),
        );
        expect(
          resolveAbliterationModelForGenerationStep({
            treatmentModel: assignment!.modelKey,
            baselineModel: assignment!.baselineModel,
            generationStepLimit: assignment!.generationStepLimit,
            stepIndex: 0,
          }),
        ).toBe(ABLITERATION_MODEL_KEY);
        expect(
          resolveAbliterationModelForGenerationStep({
            treatmentModel: assignment!.modelKey,
            baselineModel: assignment!.baselineModel,
            generationStepLimit: assignment!.generationStepLimit,
            stepIndex: 1,
          }),
        ).toBe(defaults.selectedModel);
      },
    );

    it.each(["ask", "agent"] as const)(
      "excludes every non-Pro tier from %s follow-up enrollment even with a test flag",
      async (mode) => {
        jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue("test");
        for (const subscription of [
          "free",
          "pro-plus",
          "ultra",
          "team",
        ] as const) {
          expect(
            await evaluateAbliteratedModel({
              ...continuity,
              mode,
              subscription,
            }),
          ).toBeUndefined();
        }
        expect(getPostHogFlagWithoutExposure).not.toHaveBeenCalled();
      },
    );

    it.each(["control", "test"] as const)(
      "uses the shipped Pro/Auto baseline for the %s arm",
      async (variant) => {
        jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue(variant);
        const assignment = await evaluateAbliteratedModel({
          ...continuity,
          selectedModel: "model-deepseek-v4-flash-vision-pro",
          selectedModelOverride: "auto",
        });
        expect(assignment).toMatchObject({
          baselineModel: "model-deepseek-v4.1-flash-1017-pro",
          modelKey:
            variant === "test"
              ? ABLITERATION_MODEL_KEY
              : "model-deepseek-v4.1-flash-1017-pro",
        });
      },
    );

    it.each([
      ["new or branched chat", { independentAbliterationSeedCount: 0 }],
      ["one seed", { independentAbliterationSeedCount: 1 }],
      ["failed moderation", { allowsAbliterationContinuation: false }],
      ["unchecked moderation", { moderationChecked: false }],
      ["regeneration or auto-run", { continuationTurn: false }],
      ["free plan", { subscription: "free" as const }],
      ["rescue", { limitRescue: true }],
      [
        "long message",
        {
          messages: [
            {
              ...shortFollowup[0],
              parts: [{ type: "text" as const, text: "x".repeat(201) }],
            },
          ],
        },
      ],
      [
        "unsupported file",
        {
          messages: [
            {
              ...shortFollowup[0],
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
      ],
    ])("keeps the baseline for %s", async (_label, overrides) => {
      jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue("test");
      expect(
        await evaluateAbliteratedModel({
          ...continuity,
          ...(overrides as object),
        }),
      ).toBeUndefined();
    });

    it.each(["ask", "agent"] as const)(
      "enrolls %s control without changing its model",
      async (mode) => {
        jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue("control");
        expect(
          await evaluateAbliteratedModel({ ...continuity, mode }),
        ).toMatchObject({
          key: ABLITERATED_SHORT_FOLLOWUP_KEY,
          variant: "control",
          modelKey: defaults.selectedModel,
          baselineModel: defaults.selectedModel,
          selectionSource: "history",
        });
      },
    );
    it.each([false, undefined, true, "unexpected"])(
      "does not enroll invalid/off flag value %s",
      async (value) => {
        jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue(value);
        expect(await evaluateAbliteratedModel(continuity)).toBeUndefined();
      },
    );
    it("keeps the baseline when the flag is off or unavailable", async () => {
      jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValueOnce(false);
      expect(await evaluateAbliteratedModel(continuity)).toBeUndefined();
      jest
        .mocked(getPostHogFlagWithoutExposure)
        .mockRejectedValueOnce(new Error("flag unavailable"));
      expect(await evaluateAbliteratedModel(continuity)).toBeUndefined();
    });
  });
});
