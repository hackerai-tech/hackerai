import { resolvePaidProAutoModel } from "@/lib/ai/paid-model-routing";
import { evaluateFlashRouting } from "../flash-routing";
import {
  DEEPSEEK_1017_MODEL_KEY,
  DEEPSEEK_1017_SLUG,
} from "../paid-deepseek-1017";
import { myProvider, supportsMultimodalToolResults } from "@/lib/ai/providers";
import {
  buildProviderOptions,
  getRetryFallbackModel,
  getFallbackSlugs,
  resolveServedModelForCostAccounting,
  isAutoModelSelectionForRetry,
} from "@/lib/api/chat-stream-helpers";
import {
  resolveAgentModelForImageToolResults,
  resolveAgentModelAfterSummarization,
} from "@/lib/api/agent-stream-runner";
import { calculateRawTokenCost } from "@/lib/rate-limit/token-bucket";
import { selectModel } from "@/lib/chat/chat-processor";

const base = {
  userId: "paid-user",
  subscription: "pro" as const,
  mode: "agent" as const,
  selectedModel: "model-deepseek-v4-flash-vision-pro",
  hasImages: false,
};
const client = (variant: unknown) => ({
  getFeatureFlagResult: jest.fn().mockResolvedValue({ enabled: true, variant }),
  evaluateFlags: jest.fn(),
  capture: jest.fn(),
});

describe("paid 1017 routing", () => {
  it.each([false, true])(
    "uses exact 1017 with maximum reasoning for Max uploads and image tool results (direct vision=%s)",
    (directGlmVisionEnabled) => {
      const attachmentModel = selectModel(
        "agent",
        "ultra",
        "hackerai-max",
        true,
        false,
        { directGlmVisionEnabled },
      );
      const textModel = selectModel("agent", "ultra", "hackerai-max");
      expect(textModel).toBe("model-glm-5.3");
      const toolImageModel = resolveAgentModelForImageToolResults(
        textModel,
        "agent",
        true,
        "hackerai-max",
        false,
        directGlmVisionEnabled,
        "ultra",
      );
      for (const modelKey of [attachmentModel, toolImageModel]) {
        expect(myProvider.languageModel(modelKey).modelId).toBe(
          DEEPSEEK_1017_SLUG,
        );
        expect(supportsMultimodalToolResults(modelKey)).toBe(true);
        const options = buildProviderOptions(
          true,
          "max-user",
          modelKey,
          "agent",
          {
            selectedModelOverride: "hackerai-max",
            hasMultimodalToolResults: true,
            reasoningOverride: { enabled: true, effort: "low" },
          },
        );
        expect(options.openrouter.reasoning).toEqual({
          enabled: true,
          effort: "max",
        });
        expect(options.openrouter.models).toBeUndefined();
        expect(
          isAutoModelSelectionForRetry({
            selectedModel: modelKey,
            selectedModelOverride: "hackerai-max",
          }),
        ).toBe(true);
      }
    },
  );

  it.each([false, true])(
    "preserves Max recovery routes after image tool results (direct vision=%s)",
    (directGlmVisionEnabled) => {
      for (const modelKey of [
        DEEPSEEK_1017_MODEL_KEY,
        "model-grok-4.6",
        "model-kimi-k3",
        "model-abliterated",
        "model-abliterated-large-v2",
      ]) {
        expect(
          resolveAgentModelForImageToolResults(
            modelKey,
            "agent",
            true,
            "hackerai-max",
            false,
            directGlmVisionEnabled,
            "ultra",
          ),
        ).toBe(modelKey);
      }
    },
  );

  it("keeps Max text and summarized images on GLM", () => {
    expect(
      resolveAgentModelForImageToolResults(
        "model-glm-5.3",
        "agent",
        false,
        "hackerai-max",
      ),
    ).toBe("model-glm-5.3");
    expect(
      resolveAgentModelForImageToolResults(
        "model-glm-5.3",
        "agent",
        true,
        "hackerai-max",
        true,
      ),
    ).toBe("model-glm-5.3");
  });

  it.each(["pro", "pro-plus", "ultra", "team"] as const)(
    "ships exact 1017 high for %s Auto and Pro without PostHog",
    async (subscription) => {
      for (const mode of ["ask", "agent"] as const) {
        for (const selectedModelOverride of [
          undefined,
          "auto",
          "hackerai-pro",
        ] as const) {
          for (const selectedModel of [
            "model-deepseek-v4-flash-vision-pro",
            "model-deepseek-v4-flash-vision",
            "model-glm-5.3-flash",
            "model-grok-4.5",
          ]) {
            const modelKey = resolvePaidProAutoModel({
              ...base,
              subscription,
              selectedModelOverride,
              selectedModel,
            });
            expect(modelKey).toBe(DEEPSEEK_1017_MODEL_KEY);
            const options = buildProviderOptions(
              true,
              base.userId,
              modelKey,
              mode,
              {
                reasoningOverride: { enabled: false },
              },
            );
            expect(options.openrouter.reasoning).toEqual({
              enabled: true,
              effort: "high",
            });
            const posthog = client("control");
            expect(
              await evaluateFlashRouting({
                ...base,
                subscription,
                mode,
                selectedModel: modelKey,
                posthog: posthog as never,
              }),
            ).toBeUndefined();
            expect(posthog.getFeatureFlagResult).not.toHaveBeenCalled();
            expect(posthog.evaluateFlags).not.toHaveBeenCalled();
          }
        }
      }
    },
  );
  it.each([
    { subscription: "free" as const },
    { userId: "" },
    { limitRescue: true },
    { modelPolicyActive: true },
    { selectedModelOverride: "hackerai-standard" as const },
    { selectedModelOverride: "hackerai-max" as const },
    { selectedModel: "model-glm-5.3" },
    { selectedModel: "model-abliterated" },
    { selectedModel: "model-deepseek-v4-pro-0813" },
  ])("preserves excluded requests %j", (overrides) => {
    const request = { ...base, ...overrides };
    expect(resolvePaidProAutoModel(request)).toBe(request.selectedModel);
  });
  it.each([null, client("test"), client("control")])(
    "never creates paid experiment assignments after closure",
    async (posthog) => {
      expect(
        await evaluateFlashRouting({ ...base, posthog: posthog as never }),
      ).toBeUndefined();
      expect(resolvePaidProAutoModel(base)).toBe(DEEPSEEK_1017_MODEL_KEY);
      if (posthog) expect(posthog.getFeatureFlagResult).not.toHaveBeenCalled();
    },
  );
  it("keeps snapshot through image tool results and compaction, with existing recovery", () => {
    expect(myProvider.languageModel(DEEPSEEK_1017_MODEL_KEY).modelId).toBe(
      DEEPSEEK_1017_SLUG,
    );
    expect(supportsMultimodalToolResults(DEEPSEEK_1017_MODEL_KEY)).toBe(true);
    expect(
      resolveAgentModelForImageToolResults(
        DEEPSEEK_1017_MODEL_KEY,
        "agent",
        true,
        "auto",
        false,
        true,
        "pro",
      ),
    ).toBe(DEEPSEEK_1017_MODEL_KEY);
    expect(
      resolveAgentModelAfterSummarization(
        DEEPSEEK_1017_MODEL_KEY,
        "agent",
        false,
      ),
    ).toBe(DEEPSEEK_1017_MODEL_KEY);
    expect(getRetryFallbackModel(DEEPSEEK_1017_MODEL_KEY, "agent")).toBe(
      "model-glm-5.3-flash",
    );
    expect(getFallbackSlugs(DEEPSEEK_1017_MODEL_KEY, "agent")).toEqual(
      getFallbackSlugs(base.selectedModel, "agent"),
    );
    expect(
      resolveServedModelForCostAccounting({
        modelName: DEEPSEEK_1017_MODEL_KEY,
        responseModel: "deepseek/deepseek-v4.1-flash-20261017",
      }),
    ).toBe(DEEPSEEK_1017_MODEL_KEY);
    expect(
      calculateRawTokenCost(1000000, "input", DEEPSEEK_1017_MODEL_KEY),
    ).toEqual(calculateRawTokenCost(1000000, "input", base.selectedModel));
  });
});
