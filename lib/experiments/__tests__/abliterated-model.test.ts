import {
  evaluateAbliteratedModel,
  ABLITERATED_PAID_MODERATED_DEFAULT_KEY,
  ABLITERATED_PAID_THREE_STEPS_KEY,
} from "../abliterated-model";
import { ABLITERATION_MAX_IMAGES_PER_REQUEST } from "@/lib/ai/abliteration-media";
import type { UIMessage } from "ai";
import type { SubscriptionTier } from "@/types";
import { phLogger } from "@/lib/posthog/server";

jest.mock("@/lib/posthog/server", () => ({
  phLogger: { info: jest.fn(), warn: jest.fn() },
}));
import {
  ABLITERATION_MODEL_ID,
  ABLITERATION_MODEL_KEY,
  ABLITERATION_LARGE_V2_MODEL_ID,
  ABLITERATION_LARGE_V2_MODEL_KEY,
  isAbliterationModel,
} from "@/lib/ai/abliteration";

const flagResult = (value: boolean | string | undefined) =>
  value === undefined
    ? undefined
    : {
        key: "test-flag",
        enabled: value !== false,
        variant: typeof value === "string" ? value : undefined,
        payload: undefined,
      };

describe("Abliteration model identity", () => {
  it("recognizes the internal route and provider model IDs", () => {
    expect(isAbliterationModel(ABLITERATION_MODEL_KEY)).toBe(true);
    expect(isAbliterationModel(ABLITERATION_MODEL_ID)).toBe(true);
    expect(isAbliterationModel(ABLITERATION_LARGE_V2_MODEL_KEY)).toBe(true);
    expect(isAbliterationModel(ABLITERATION_LARGE_V2_MODEL_ID)).toBe(true);
    expect(isAbliterationModel("model-deepseek-v4-flash-0731")).toBe(false);
  });
});

describe("paid moderation-gated Abliteration after trial rollback", () => {
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
      "routes every eligible %s selector without a historical flag lookup",
      async (subscription) => {
        for (const selectedModelOverride of [
          undefined,
          "auto",
          "hackerai-standard",
          "hackerai-pro",
          "hackerai-max",
        ] as const) {
          const getFeatureFlagResult = jest
            .fn()
            .mockRejectedValue(new Error("PostHog unavailable"));
          const assignment = await evaluateAbliteratedModel({
            ...defaults,
            mode,
            subscription,
            selectedModelOverride,
            posthog: { getFeatureFlagResult },
          });
          expect(assignment).toMatchObject({
            key: ABLITERATED_PAID_MODERATED_DEFAULT_KEY,
            variant: "test",
            modelKey: ABLITERATION_MODEL_KEY,
            baselineModel: defaults.selectedModel,
            selectionSource: "moderation",
            moderationChecked: true,
          });
          expect(getFeatureFlagResult).toHaveBeenCalledTimes(1);
        }
      },
    );
    it("does not depend on a configured analytics client", async () => {
      await expect(
        evaluateAbliteratedModel({ ...defaults, mode, posthog: null }),
      ).resolves.toMatchObject({ modelKey: ABLITERATION_MODEL_KEY });
    });
    it.each([
      { subscription: "free" as const },
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
      const getFeatureFlagResult = jest
        .fn()
        .mockResolvedValue(flagResult("test"));
      await expect(
        evaluateAbliteratedModel({
          ...defaults,
          mode,
          ...overrides,
          posthog: { getFeatureFlagResult },
        }),
      ).resolves.toBeUndefined();
      expect(getFeatureFlagResult).not.toHaveBeenCalled();
    });
    it("keeps the baseline when the provider credential is absent", async () => {
      delete process.env.ABLITERATION_API_KEY;
      await expect(
        evaluateAbliteratedModel({ ...defaults, mode, posthog: null }),
      ).resolves.toBeUndefined();
    });
    it.each(["control", "test"] as const)(
      "assigns %s using the authenticated ID without emitting exposure",
      async (variant) => {
        const getFeatureFlagResult = jest
          .fn()
          .mockResolvedValue(flagResult(variant));
        const assignment = await evaluateAbliteratedModel({
          ...defaults,
          mode,
          posthog: { getFeatureFlagResult },
        });
        expect(assignment).toMatchObject({
          key: ABLITERATED_PAID_THREE_STEPS_KEY,
          variant,
          modelKey: ABLITERATION_MODEL_KEY,
          baselineModel: defaults.selectedModel,
          generationStepLimit: variant === "test" ? 3 : 1,
        });
        expect(getFeatureFlagResult).toHaveBeenCalledWith(
          ABLITERATED_PAID_THREE_STEPS_KEY,
          defaults.userId,
          expect.objectContaining({
            sendFeatureFlagEvents: false,
            personProperties: {
              subscription: "pro",
              subscription_tier: "pro",
            },
          }),
        );
      },
    );
    it.each([false, true, undefined, "unexpected"])(
      "keeps the shipped one-step default for flag value %s",
      async (value) => {
        const assignment = await evaluateAbliteratedModel({
          ...defaults,
          mode,
          posthog: {
            getFeatureFlagResult: jest
              .fn()
              .mockResolvedValue(flagResult(value)),
          },
        });
        expect(assignment).toMatchObject({
          key: ABLITERATED_PAID_MODERATED_DEFAULT_KEY,
          modelKey: ABLITERATION_MODEL_KEY,
        });
        expect(assignment?.generationStepLimit).toBeUndefined();
      },
    );
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
          posthog: null,
        }),
      ).resolves.toMatchObject({
        modelKey: ABLITERATION_MODEL_KEY,
        baselineModel: "model-grok-4.6",
      });
    },
  );
  it("diagnoses the default without customer content and without changing behavior on logging failure", async () => {
    const previewDiagnosticContext = {
      chatId: "test-chat",
      requestId: "test-run",
    };
    const result = await evaluateAbliteratedModel({
      ...defaults,
      posthog: null,
      previewDiagnosticContext,
    });
    expect(result?.key).toBe(ABLITERATED_PAID_MODERATED_DEFAULT_KEY);
    expect(phLogger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        reason: "moderated_default",
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
        posthog: null,
        previewDiagnosticContext,
      }),
    ).resolves.toMatchObject({ modelKey: ABLITERATION_MODEL_KEY });
  });
  it("reports lookup failure without error content and retains fallback if logging fails", async () => {
    const posthog = {
      getFeatureFlagResult: jest
        .fn()
        .mockRejectedValue(new Error("private error content")),
    };
    await expect(
      evaluateAbliteratedModel({ ...defaults, posthog }),
    ).resolves.toMatchObject({ key: ABLITERATED_PAID_MODERATED_DEFAULT_KEY });
    expect(phLogger.warn).toHaveBeenCalledWith(
      "Abliteration three-step flag lookup failed",
      expect.objectContaining({
        experiment_key: ABLITERATED_PAID_THREE_STEPS_KEY,
        error_type: "Error",
      }),
    );
    expect(JSON.stringify(jest.mocked(phLogger.warn).mock.calls)).not.toContain(
      "private error content",
    );
    jest.mocked(phLogger.warn).mockImplementationOnce(() => {
      throw new Error("logger unavailable");
    });
    await expect(
      evaluateAbliteratedModel({ ...defaults, posthog }),
    ).resolves.toMatchObject({ key: ABLITERATED_PAID_MODERATED_DEFAULT_KEY });
  });
});
