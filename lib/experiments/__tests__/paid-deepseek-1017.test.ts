import {
  evaluateFlashRouting,
  createFlashRoutingExposureRecorder,
  getActiveFlashRoutingAssignment,
} from "../flash-routing";
import {
  PAID_DEEPSEEK_1017_KEY,
  DEEPSEEK_1017_MODEL_KEY,
  DEEPSEEK_1017_SLUG,
} from "../paid-deepseek-1017";
import { myProvider, supportsMultimodalToolResults } from "@/lib/ai/providers";
import {
  buildProviderOptions,
  getRetryFallbackModel,
  getFallbackSlugs,
  resolveServedModelForCostAccounting,
} from "@/lib/api/chat-stream-helpers";
import {
  resolveAgentModelForImageToolResults,
  resolveAgentModelAfterSummarization,
} from "@/lib/api/agent-stream-runner";
import { calculateRawTokenCost } from "@/lib/rate-limit/token-bucket";

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
  it.each(["ask", "agent"] as const)(
    "preserves control and serves exact snapshot high in %s",
    async (mode) => {
      for (const variant of ["control", "test"]) {
        const posthog = client(variant);
        const assignment = await evaluateFlashRouting({
          ...base,
          mode,
          posthog: posthog as never,
        });
        expect(assignment?.modelKey).toBe(
          variant === "test" ? DEEPSEEK_1017_MODEL_KEY : base.selectedModel,
        );
        expect(posthog.getFeatureFlagResult).toHaveBeenCalledWith(
          PAID_DEEPSEEK_1017_KEY,
          base.userId,
          {
            sendFeatureFlagEvents: false,
            personProperties: { subscription_tier: "pro" },
          },
        );
        expect(posthog.capture).not.toHaveBeenCalled();
        const options = buildProviderOptions(
          true,
          base.userId,
          DEEPSEEK_1017_MODEL_KEY,
          mode,
          { reasoningOverride: { enabled: false } },
        );
        expect(options.openrouter.reasoning).toEqual({
          enabled: true,
          effort: "high",
        });
      }
    },
  );
  it.each(["pro", "pro-plus", "ultra", "team"] as const)(
    "enrolls paid %s with Auto and Pro, including native images",
    async (subscription) => {
      for (const selectedModelOverride of [
        undefined,
        "auto",
        "hackerai-pro",
      ] as const) {
        expect(
          await evaluateFlashRouting({
            ...base,
            subscription,
            selectedModelOverride,
            hasImages: true,
            posthog: client("test") as never,
          }),
        ).toMatchObject({
          key: PAID_DEEPSEEK_1017_KEY,
          modelKey: DEEPSEEK_1017_MODEL_KEY,
        });
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
  ])("never evaluates excluded requests %j", async (overrides) => {
    const posthog = client("test");
    expect(
      await evaluateFlashRouting({
        ...base,
        ...overrides,
        posthog: posthog as never,
      }),
    ).toBeUndefined();
    expect(posthog.getFeatureFlagResult).not.toHaveBeenCalled();
  });
  it.each([true, false, undefined, "unknown"])(
    "fails closed for invalid variant %s",
    async (variant) => {
      expect(
        await evaluateFlashRouting({
          ...base,
          posthog: client(variant) as never,
        }),
      ).toBeUndefined();
    },
  );
  it("fails closed on evaluation failure and inactive flags", async () => {
    const posthog = client("test");
    posthog.getFeatureFlagResult.mockRejectedValueOnce(
      new Error("unavailable"),
    );
    expect(
      await evaluateFlashRouting({ ...base, posthog: posthog as never }),
    ).toBeUndefined();
    posthog.getFeatureFlagResult.mockResolvedValueOnce({
      enabled: false,
      variant: "test",
    });
    expect(
      await evaluateFlashRouting({ ...base, posthog: posthog as never }),
    ).toBeUndefined();
  });
  it("records exposure only at matching provider start and excludes rescue", async () => {
    const posthog = client("test");
    const assignment = await evaluateFlashRouting({
      ...base,
      posthog: posthog as never,
    });
    const record = createFlashRoutingExposureRecorder({
      ...base,
      assignment,
      posthog: posthog as never,
      requestId: "original-message",
    });
    record("other-model");
    expect(posthog.capture).not.toHaveBeenCalled();
    record(DEEPSEEK_1017_SLUG);
    record(DEEPSEEK_1017_SLUG);
    expect(posthog.capture).toHaveBeenCalledTimes(1);
    expect(posthog.capture.mock.calls[0][0].properties).toMatchObject({
      experiment_key: PAID_DEEPSEEK_1017_KEY,
      experiment_request_id: "original-message",
      message_id: "original-message",
      baseline_model: base.selectedModel,
    });
    expect(
      getActiveFlashRoutingAssignment(
        assignment,
        DEEPSEEK_1017_MODEL_KEY,
        true,
      ),
    ).toBeUndefined();
  });
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

it.each(["model-glm-5.3-flash", "model-grok-4.5"])(
  "records control exposure after startup compaction changes %s",
  async (selectedModel) => {
    const posthog = client("control");
    const assignment = await evaluateFlashRouting({
      ...base,
      selectedModel,
      hasImages: true,
      posthog: posthog as never,
    });
    const continuationModel = myProvider.languageModel(
      resolveAgentModelAfterSummarization(selectedModel, "agent", false),
    ).modelId;
    expect(continuationModel).not.toBe(assignment!.configuredModel);
    const record = createFlashRoutingExposureRecorder({
      ...base,
      assignment,
      posthog: posthog as never,
      requestId: "compacted",
      controlContinuationModel: continuationModel,
    });
    record("unrelated-model");
    expect(posthog.capture).not.toHaveBeenCalled();
    record(continuationModel);
    record(assignment!.configuredModel);
    record(continuationModel);
    expect(posthog.capture).toHaveBeenCalledTimes(1);
    expect(posthog.capture.mock.calls[0][0].properties).toMatchObject({
      experiment_variant: "control",
      configured_model: continuationModel,
      assigned_configured_model: assignment!.configuredModel,
      experiment_request_id: "compacted",
    });
    const treatment = await evaluateFlashRouting({
      ...base,
      posthog: client("test") as never,
    });
    const capture = jest.fn();
    createFlashRoutingExposureRecorder({
      ...base,
      assignment: treatment,
      posthog: { capture } as never,
      requestId: "test",
      controlContinuationModel: continuationModel,
    })(continuationModel);
    expect(capture).not.toHaveBeenCalled();
  },
);
