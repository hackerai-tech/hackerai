import {
  evaluateAbliteratedModel,
  evaluatePaidFirstStepVariant,
  ABLITERATED_PAID_FIRST_STEP_KEY,
  ABLITERATED_PAID_MODERATED_DEFAULT_KEY,
} from "../abliterated-model";
import { ABLITERATION_MAX_IMAGES_PER_REQUEST } from "@/lib/ai/abliteration-media";
import type { UIMessage } from "ai";
import type { SubscriptionTier } from "@/types";
import { phLogger } from "@/lib/posthog/server";

jest.mock("@/lib/posthog/server", () => ({
  phLogger: { info: jest.fn() },
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

describe("paid Abliteration default and first-step trial", () => {
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
  describe("independent paid first-step enrollment", () => {
    it.each(["ask", "agent"] as const)(
      "assigns unmoderated %s requests to base Abliteration without historical lookup",
      async (mode) => {
        const getFeatureFlagResult = jest.fn();
        await expect(
          evaluateAbliteratedModel({
            ...defaults,
            mode,
            selectedModel: "model-grok-4.6",
            moderationEligible: false,
            moderationChecked: false,
            paidFirstStepVariant: "test",
            posthog: { getFeatureFlagResult },
          }),
        ).resolves.toMatchObject({
          key: ABLITERATED_PAID_FIRST_STEP_KEY,
          modelKey: ABLITERATION_MODEL_KEY,
          baselineModel: "model-grok-4.6",
          selectionSource: "paid_first_step",
          moderationEligible: false,
          moderationChecked: false,
        });
        expect(getFeatureFlagResult).not.toHaveBeenCalled();
      },
    );
    it("keeps unmoderated controls on the baseline despite historical treatment", async () => {
      const getFeatureFlagResult = jest
        .fn()
        .mockResolvedValue(flagResult("test"));
      await expect(
        evaluateAbliteratedModel({
          ...defaults,
          paidFirstStepVariant: "control",
          moderationEligible: false,
          posthog: { getFeatureFlagResult },
        }),
      ).resolves.toMatchObject({
        key: ABLITERATED_PAID_FIRST_STEP_KEY,
        variant: "control",
        modelKey: defaults.selectedModel,
        baselineModel: defaults.selectedModel,
      });
      expect(getFeatureFlagResult).not.toHaveBeenCalled();
    });
    it.each([true, false, "unexpected", undefined])(
      "ignores invalid enrollment %s",
      async (value) => {
        const getFeatureFlagResult = jest
          .fn()
          .mockResolvedValue(flagResult(value));
        await expect(
          evaluatePaidFirstStepVariant({
            ...defaults,
            posthog: { getFeatureFlagResult },
          }),
        ).resolves.toBeUndefined();
      },
    );
    it("evaluates a stable authenticated user without recording exposure", async () => {
      const getFeatureFlagResult = jest
        .fn()
        .mockResolvedValue(flagResult("test"));
      await expect(
        evaluatePaidFirstStepVariant({
          ...defaults,
          posthog: { getFeatureFlagResult },
        }),
      ).resolves.toBe("test");
      expect(getFeatureFlagResult).toHaveBeenCalledWith(
        ABLITERATED_PAID_FIRST_STEP_KEY,
        defaults.userId,
        {
          sendFeatureFlagEvents: false,
          personProperties: { subscription: "pro", subscription_tier: "pro" },
        },
      );
    });
    it.each([
      { subscription: "free" as const },
      { limitRescue: true },
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
                url: "https://example.test/doc.pdf",
              },
            ],
          },
        ],
      },
    ])("preserves exclusions before any flag lookup: %j", async (overrides) => {
      const getFeatureFlagResult = jest
        .fn()
        .mockResolvedValue(flagResult("test"));
      await expect(
        evaluatePaidFirstStepVariant({
          ...defaults,
          ...overrides,
          posthog: { getFeatureFlagResult },
        }),
      ).resolves.toBeUndefined();
      expect(getFeatureFlagResult).not.toHaveBeenCalled();
      await expect(
        evaluateAbliteratedModel({
          ...defaults,
          ...overrides,
          paidFirstStepVariant: "test",
          posthog: { getFeatureFlagResult },
        }),
      ).resolves.toBeUndefined();
    });
    it("preserves current routing when the new lookup fails", async () => {
      const getFeatureFlagResult = jest
        .fn()
        .mockRejectedValue(new Error("flag unavailable"));
      await expect(
        evaluatePaidFirstStepVariant({
          ...defaults,
          posthog: { getFeatureFlagResult },
        }),
      ).resolves.toBeUndefined();
    });
  });
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
          expect(getFeatureFlagResult).not.toHaveBeenCalled();
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
    it.each([false, true])(
      "new control uses the moderated default only when moderation eligible=%s",
      async (moderationEligible) => {
        const baseline = "model-grok-4.6";
        await expect(
          evaluateAbliteratedModel({
            ...defaults,
            mode,
            selectedModel: baseline,
            moderationEligible,
            paidFirstStepVariant: "control",
            posthog: null,
          }),
        ).resolves.toMatchObject({
          key: ABLITERATED_PAID_FIRST_STEP_KEY,
          variant: "control",
          modelKey: moderationEligible ? ABLITERATION_MODEL_KEY : baseline,
          baselineModel: baseline,
          moderationChecked: true,
        });
      },
    );
    it.each(["test", "control"] as const)(
      "never routes excluded requests even with a supplied %s assignment",
      async (paidFirstStepVariant) => {
        for (const overrides of [
          { subscription: "free" as const },
          { limitRescue: true },
        ]) {
          await expect(
            evaluateAbliteratedModel({
              ...defaults,
              mode,
              ...overrides,
              paidFirstStepVariant,
              posthog: null,
            }),
          ).resolves.toBeUndefined();
        }
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
});
