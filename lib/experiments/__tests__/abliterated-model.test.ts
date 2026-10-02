import {
  evaluateAbliteratedModel,
  ABLITERATED_EXPERIMENT_KEY,
  ABLITERATED_MAX_EXPERIMENT_KEY,
  ABLITERATION_CONTINUITY_FLAG,
} from "../abliterated-model";
import { ABLITERATION_MAX_IMAGES_PER_REQUEST } from "@/lib/ai/abliteration-media";
import type { UIMessage } from "ai";
import type { SelectedModel, SubscriptionTier } from "@/types";
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

describe("moderation-gated Abliteration assignment", () => {
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
  describe("Preview Pro/Max diagnostics", () => {
    const previewDiagnosticContext = {
      chatId: "test-chat",
      requestId: "test-run",
    };
    it.each([
      {
        moderationEligible: false,
        variant: "test",
        reason: "moderation_not_eligible",
      },
      {
        moderationEligible: true,
        variant: false,
        reason: "flag_inactive_or_unmatched",
      },
      {
        moderationEligible: true,
        variant: undefined,
        reason: "flag_unavailable",
      },
      { moderationEligible: true, variant: "test", reason: "assigned" },
    ])(
      "records the decision without content: $reason",
      async ({ moderationEligible, variant, reason }) => {
        const getFeatureFlagResult = jest
          .fn()
          .mockResolvedValue(flagResult(variant));
        const result = await evaluateAbliteratedModel({
          ...defaults,
          moderationEligible,
          selectedModelOverride: "hackerai-max",
          posthog: { getFeatureFlagResult },
          previewDiagnosticContext,
        });
        expect(phLogger.info).toHaveBeenCalledWith(
          "Preview Abliteration assignment decision",
          expect.objectContaining({
            reason,
            moderation_eligible: moderationEligible,
            provider_configured: true,
            requestId: "test-run",
          }),
        );
        expect(result?.variant).toBe(
          reason === "assigned" ? "test" : undefined,
        );
        expect(
          JSON.stringify(jest.mocked(phLogger.info).mock.calls),
        ).not.toContain("private test prompt");
        if (!moderationEligible)
          expect(getFeatureFlagResult).not.toHaveBeenCalled();
      },
    );
    it("reports a missing provider before any flag lookup", async () => {
      delete process.env.ABLITERATION_API_KEY;
      const getFeatureFlagResult = jest.fn();
      await evaluateAbliteratedModel({
        ...defaults,
        selectedModelOverride: "hackerai-max",
        posthog: { getFeatureFlagResult },
        previewDiagnosticContext,
      });
      expect(phLogger.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          reason: "provider_not_configured",
          provider_configured: false,
        }),
      );
      expect(getFeatureFlagResult).not.toHaveBeenCalled();
    });
    it("reports lookup failures and retains baseline", async () => {
      const getFeatureFlagResult = jest
        .fn()
        .mockRejectedValue(new Error("unavailable"));
      await expect(
        evaluateAbliteratedModel({
          ...defaults,
          selectedModelOverride: "hackerai-max",
          posthog: { getFeatureFlagResult },
          previewDiagnosticContext,
        }),
      ).resolves.toBeUndefined();
      expect(phLogger.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ reason: "flag_lookup_failed" }),
      );
    });
    it("does not diagnose Production calls and cannot alter treatment on logger failure", async () => {
      const posthog = {
        getFeatureFlagResult: jest.fn().mockResolvedValue(flagResult("test")),
      };
      await evaluateAbliteratedModel({
        ...defaults,
        selectedModelOverride: "hackerai-max",
        posthog,
      });
      expect(phLogger.info).not.toHaveBeenCalled();
      jest.mocked(phLogger.info).mockImplementationOnce(() => {
        throw new Error("logging unavailable");
      });
      await expect(
        evaluateAbliteratedModel({
          ...defaults,
          selectedModelOverride: "hackerai-max",
          posthog,
          previewDiagnosticContext,
        }),
      ).resolves.toMatchObject({
        variant: "test",
        modelKey: "model-abliterated",
      });
    });
  });
  it.each([undefined, "auto", "hackerai-standard"] as const)(
    "routes an eligible %s request only for an explicit test variant",
    async (selectedModelOverride) => {
      const getFeatureFlagResult = jest
        .fn()
        .mockResolvedValue(flagResult("test"));
      const result = await evaluateAbliteratedModel({
        ...defaults,
        selectedModelOverride,
        posthog: { getFeatureFlagResult },
      });
      expect(result).toMatchObject({
        modelKey: "model-abliterated",
      });
      expect(getFeatureFlagResult).toHaveBeenCalledWith(
        ABLITERATED_EXPERIMENT_KEY,
        "u",
        {
          sendFeatureFlagEvents: false,
          personProperties: { subscription: "pro", subscription_tier: "pro" },
        },
      );
      expect(JSON.stringify(getFeatureFlagResult.mock.calls)).not.toContain(
        "private test prompt",
      );
    },
  );
  it.each([
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
    const getFeatureFlagResult = jest
      .fn()
      .mockResolvedValue(flagResult("test"));
    expect(
      await evaluateAbliteratedModel({
        ...defaults,
        ...overrides,
        posthog: { getFeatureFlagResult },
      }),
    ).toBeUndefined();
    expect(getFeatureFlagResult).not.toHaveBeenCalled();
  });

  describe.each(["ask", "agent"] as const)("free %s exclusion", (mode) => {
    it.each(["test", "control", true, false, undefined])(
      "keeps the free baseline without evaluating flags, even if they return %s",
      async (variant) => {
        const getFeatureFlagResult = jest
          .fn()
          .mockResolvedValue(flagResult(variant));
        const baselineModel =
          mode === "ask" ? "ask-model-free-glm" : "agent-model-free";
        const assignment = await evaluateAbliteratedModel({
          ...defaults,
          mode,
          subscription: "free",
          selectedModel: baselineModel,
          posthog: { getFeatureFlagResult },
        });
        expect(assignment).toBeUndefined();
        expect(assignment?.modelKey ?? baselineModel).toBe(baselineModel);
        expect(getFeatureFlagResult).not.toHaveBeenCalled();
      },
    );
    it("does not restore treatment from an existing Abliteration chat history", async () => {
      const getFeatureFlagResult = jest
        .fn()
        .mockResolvedValue(flagResult("test"));
      await expect(
        evaluateAbliteratedModel({
          ...defaults,
          mode,
          subscription: "free",
          allowsAbliterationContinuation: true,
          independentAbliterationResponses: 5,
          posthog: { getFeatureFlagResult },
        }),
      ).resolves.toBeUndefined();
      expect(getFeatureFlagResult).not.toHaveBeenCalled();
    });
  });
  it.each(["pro", "pro-plus", "ultra", "team"] as const)(
    "preserves paid %s treatment in Ask and Agent",
    async (subscription) => {
      for (const mode of ["ask", "agent"] as const) {
        const getFeatureFlagResult = jest
          .fn()
          .mockResolvedValue(flagResult("test"));
        await expect(
          evaluateAbliteratedModel({
            ...defaults,
            mode,
            subscription,
            posthog: { getFeatureFlagResult },
          }),
        ).resolves.toMatchObject({
          modelKey: ABLITERATION_MODEL_KEY,
          key: ABLITERATED_EXPERIMENT_KEY,
        });
      }
    },
  );

  it("keeps a request at the Abliteration image limit eligible", async () => {
    const getFeatureFlagResult = jest
      .fn()
      .mockResolvedValue(flagResult("test"));

    await expect(
      evaluateAbliteratedModel({
        ...defaults,
        messages: imageAttachmentHistory(ABLITERATION_MAX_IMAGES_PER_REQUEST),
        posthog: { getFeatureFlagResult },
      }),
    ).resolves.toMatchObject({ modelKey: ABLITERATION_MODEL_KEY });
    expect(getFeatureFlagResult).toHaveBeenCalledTimes(1);
  });
  it("keeps over-limit image requests eligible for vision preprocessing", async () => {
    const getFeatureFlagResult = jest
      .fn()
      .mockResolvedValue(flagResult("test"));

    await expect(
      evaluateAbliteratedModel({
        ...defaults,
        messages: imageAttachmentTurn(ABLITERATION_MAX_IMAGES_PER_REQUEST + 1),
        posthog: { getFeatureFlagResult },
      }),
    ).resolves.toMatchObject({ modelKey: ABLITERATION_MODEL_KEY });
    expect(getFeatureFlagResult).toHaveBeenCalledTimes(1);
  });
  it("keeps over-limit image history eligible across messages", async () => {
    const getFeatureFlagResult = jest
      .fn()
      .mockResolvedValue(flagResult("test"));
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
        posthog: { getFeatureFlagResult },
      }),
    ).resolves.toMatchObject({ modelKey: ABLITERATION_MODEL_KEY });
    expect(getFeatureFlagResult).toHaveBeenCalledTimes(1);
  });
  it.each([
    {
      name: "explicit Pro",
      selectedModelOverride: "hackerai-pro" as SelectedModel,
      selectedModel: "model-deepseek-v4-flash-vision-pro" as const,
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
        posthog: {
          getFeatureFlagResult: jest
            .fn()
            .mockImplementation(async (key: string) =>
              flagResult(
                key === ABLITERATED_MAX_EXPERIMENT_KEY ? false : "test",
              ),
            ),
        },
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
      selectedModel: "model-deepseek-v4-flash-vision-pro" as const,
      messages: imageAttachmentMessages,
    },
    {
      name: "Pro image-view tool result",
      selectedModelOverride: "hackerai-pro" as SelectedModel,
      selectedModel: "model-deepseek-v4-flash-vision-pro" as const,
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
          posthog: {
            getFeatureFlagResult: jest
              .fn()
              .mockResolvedValue(flagResult("test")),
          },
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
        posthog: {
          getFeatureFlagResult: jest.fn().mockResolvedValue(flagResult("test")),
        },
      }),
    ).toMatchObject({ modelKey: ABLITERATION_MODEL_KEY });
  });
  it.each([false, true, undefined, "unexpected"])(
    "fails closed on %s",
    async (value) => {
      expect(
        await evaluateAbliteratedModel({
          ...defaults,
          posthog: {
            getFeatureFlagResult: jest
              .fn()
              .mockResolvedValue(flagResult(value)),
          },
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
        posthog: {
          getFeatureFlagResult: jest
            .fn()
            .mockResolvedValue(flagResult("control")),
        },
      }),
    ).toMatchObject({
      variant: "control",
      modelKey: "model-deepseek-v4-pro-0813",
    });
  });
  it("fails closed on missing configuration or lookup failure", async () => {
    const getFeatureFlagResult = jest
      .fn()
      .mockRejectedValue(new Error("offline"));
    expect(
      await evaluateAbliteratedModel({
        ...defaults,
        posthog: { getFeatureFlagResult },
      }),
    ).toBeUndefined();
    getFeatureFlagResult.mockClear();
    delete process.env.ABLITERATION_API_KEY;
    expect(
      await evaluateAbliteratedModel({
        ...defaults,
        posthog: { getFeatureFlagResult },
      }),
    ).toBeUndefined();
    expect(getFeatureFlagResult).not.toHaveBeenCalled();
  });
  const historyDefaults = {
    ...defaults,
    moderationEligible: false,
    allowsAbliterationContinuation: true,
    independentAbliterationResponses: 2,
  };
  describe.each(["ask", "agent"] as const)(
    "Pro/Max first-step trial in %s",
    (mode) => {
      describe.each(["hackerai-pro", "hackerai-max"] as const)(
        "%s selector",
        (selectedModelOverride) => {
          it.each(["pro", "pro-plus", "ultra", "team"] as const)(
            "uses base Abliteration for authorized %s requests and preserves controls",
            async (subscription) => {
              for (const variant of ["test", "control"] as const) {
                const getFeatureFlagResult = jest
                  .fn()
                  .mockResolvedValue(flagResult(variant));
                const selectedModel = "model-glm-5.3" as const;
                await expect(
                  evaluateAbliteratedModel({
                    ...defaults,
                    mode,
                    subscription,
                    selectedModel,
                    selectedModelOverride,
                    posthog: { getFeatureFlagResult },
                  }),
                ).resolves.toMatchObject({
                  key: ABLITERATED_MAX_EXPERIMENT_KEY,
                  variant,
                  modelKey:
                    variant === "test" ? ABLITERATION_MODEL_KEY : selectedModel,
                  baselineModel: selectedModel,
                  selectionSource: "moderation",
                });
                expect(getFeatureFlagResult).toHaveBeenCalledTimes(1);
              }
            },
          );
          it.each([
            { selectedModelOverride: "auto" as const },
            { selectedModelOverride: "hackerai-standard" as const },
            { moderationEligible: false },
            {
              moderationEligible: false,
              allowsAbliterationContinuation: true,
              independentAbliterationResponses: 5,
            },
            { subscription: "free" as const },
            { limitRescue: true },
          ])(
            "does not enroll outside the moderated Pro/Max population: %j",
            async (overrides) => {
              const getFeatureFlagResult = jest
                .fn()
                .mockImplementation(async (key: string) =>
                  flagResult(
                    key === ABLITERATED_MAX_EXPERIMENT_KEY ? "test" : false,
                  ),
                );
              await expect(
                evaluateAbliteratedModel({
                  ...defaults,
                  mode,
                  selectedModelOverride,
                  ...overrides,
                  posthog: { getFeatureFlagResult },
                }),
              ).resolves.toBeUndefined();
              expect(
                getFeatureFlagResult.mock.calls.some(
                  ([key]) => key === ABLITERATED_MAX_EXPERIMENT_KEY,
                ),
              ).toBe(false);
            },
          );
          it.each([false, undefined, "unexpected"])(
            "preserves the baseline when the new flag returns %s and the legacy flag is off",
            async (value) => {
              const getFeatureFlagResult = jest
                .fn()
                .mockImplementation(async (key: string) =>
                  flagResult(
                    key === ABLITERATED_MAX_EXPERIMENT_KEY ? value : false,
                  ),
                );
              await expect(
                evaluateAbliteratedModel({
                  ...defaults,
                  mode,
                  selectedModelOverride,
                  posthog: { getFeatureFlagResult },
                }),
              ).resolves.toBeUndefined();
            },
          );
        },
      );
    },
  );
  it("uses history only within parent treatment and an explicitly enabled continuity flag", async () => {
    const getFeatureFlagResult = jest
      .fn()
      .mockImplementation(async (key: string) =>
        flagResult(key === ABLITERATION_CONTINUITY_FLAG ? true : "test"),
      );
    await expect(
      evaluateAbliteratedModel({
        ...historyDefaults,
        posthog: { getFeatureFlagResult },
      }),
    ).resolves.toMatchObject({
      modelKey: ABLITERATION_MODEL_KEY,
      selectionSource: "history",
      independentHistoryCount: 2,
    });
    expect(getFeatureFlagResult).toHaveBeenCalledTimes(2);
  });
  it.each([
    { allowsAbliterationContinuation: false },
    { independentAbliterationResponses: 1 },
    { independentAbliterationResponses: NaN },
    { subscription: "free" as SubscriptionTier },
    { subscription: "free" as SubscriptionTier, mode: "agent" as const },
    { limitRescue: true },
    {
      messages: [
        {
          id: "file",
          role: "user" as const,
          parts: [
            {
              type: "file" as const,
              mediaType: "application/pdf",
              url: "https://example.test/a.pdf",
            },
          ],
        },
      ],
    },
  ])("preserves all eligibility gates for history: %j", async (overrides) => {
    const getFeatureFlagResult = jest.fn().mockResolvedValue(flagResult(true));
    await expect(
      evaluateAbliteratedModel({
        ...historyDefaults,
        ...overrides,
        posthog: { getFeatureFlagResult },
      }),
    ).resolves.toBeUndefined();
    expect(getFeatureFlagResult).not.toHaveBeenCalled();
  });
  it.each([false, undefined, "test"])(
    "fails closed on continuity flag %s",
    async (value) => {
      const getFeatureFlagResult = jest
        .fn()
        .mockResolvedValueOnce(flagResult("test"))
        .mockResolvedValueOnce(flagResult(value));
      await expect(
        evaluateAbliteratedModel({
          ...historyDefaults,
          posthog: { getFeatureFlagResult },
        }),
      ).resolves.toBeUndefined();
    },
  );
  it("does not move parent controls into continuity treatment", async () => {
    const getFeatureFlagResult = jest
      .fn()
      .mockResolvedValue(flagResult("control"));
    await expect(
      evaluateAbliteratedModel({
        ...historyDefaults,
        posthog: { getFeatureFlagResult },
      }),
    ).resolves.toBeUndefined();
    expect(getFeatureFlagResult).toHaveBeenCalledTimes(1);
  });
  it("keeps independent moderation selection independent even with enough history", async () => {
    const getFeatureFlagResult = jest
      .fn()
      .mockResolvedValue(flagResult("test"));
    await expect(
      evaluateAbliteratedModel({
        ...historyDefaults,
        moderationEligible: true,
        posthog: { getFeatureFlagResult },
      }),
    ).resolves.toMatchObject({ selectionSource: "moderation" });
    expect(getFeatureFlagResult).toHaveBeenCalledTimes(1);
  });
});
