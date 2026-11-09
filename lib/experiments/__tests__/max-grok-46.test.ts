import { UsageTracker } from "@/lib/usage-tracker";
import {
  evaluateMaxGrok46,
  MaxModelTelemetry,
  MAX_GROK_46_KEY,
  MAX_GROK_46_EXPOSURE_EVENT,
  MAX_GROK_46_OUTCOME_EVENT,
} from "../max-grok-46";
import {
  DEEPSEEK_1017_MODEL_KEY,
  DEEPSEEK_1017_SLUG,
} from "../paid-deepseek-1017";
import {
  getRetryFallbackModel,
  buildProviderOptions,
} from "@/lib/api/chat-stream-helpers";
import { getNextProviderDisconnectRetryModel } from "@/lib/chat/agent-long-provider-retry";

jest.mock("@/lib/db/actions", () => ({ getNotes: jest.fn() }));
const base = {
  userId: "signed-in-account",
  mode: "agent" as const,
  subscription: "ultra" as const,
  selectedModelOverride: "hackerai-max" as const,
  hasImages: false,
};
function client(variant: string | boolean | undefined) {
  return {
    getFeatureFlagResult: jest.fn(async () =>
      variant === undefined
        ? undefined
        : {
            enabled: variant !== false,
            variant: typeof variant === "string" ? variant : undefined,
          },
    ),
    capture: jest.fn(),
  };
}

describe("Max model experiment policy", () => {
  it.each(["control", "test"] as const)(
    "keeps %s assignment on the account identity for text and images",
    async (variant) => {
      const posthog = client(variant);
      for (const hasImages of [false, true]) {
        const result = await evaluateMaxGrok46({ ...base, posthog, hasImages });
        expect(result?.modelKey).toBe(
          variant === "test"
            ? "model-grok-4.6"
            : hasImages
              ? DEEPSEEK_1017_MODEL_KEY
              : "model-glm-5.3",
        );
      }
      for (const call of posthog.getFeatureFlagResult.mock
        .calls as unknown as unknown[][])
        expect(call).toEqual([
          MAX_GROK_46_KEY,
          base.userId,
          {
            sendFeatureFlagEvents: false,
            personProperties: {
              subscription: "ultra",
              subscription_tier: "ultra",
            },
          },
        ]);
      expect(posthog.capture).not.toHaveBeenCalled();
    },
  );
  it.each([false, true, undefined, "unexpected"])(
    "does not enroll on unavailable/invalid variant %p",
    async (variant) => {
      expect(
        await evaluateMaxGrok46({ ...base, posthog: client(variant) }),
      ).toBeUndefined();
    },
  );
  it("excludes free, other tiers, Ask and allowance rescue before flag evaluation", async () => {
    const posthog = client("test");
    for (const override of [
      { subscription: "free" },
      { selectedModelOverride: "hackerai-pro" },
      { mode: "ask" },
      { limitRescue: true },
    ]) {
      expect(
        await evaluateMaxGrok46({ ...base, ...override, posthog } as Parameters<
          typeof evaluateMaxGrok46
        >[0]),
      ).toBeUndefined();
    }
    expect(posthog.getFeatureFlagResult).not.toHaveBeenCalled();
  });
  it("uses GLM for Grok text recovery and DeepSeek max when images reach the provider", () => {
    const text = getRetryFallbackModel(
      "model-grok-4.6",
      "agent",
      "hackerai-max",
    );
    const image = getRetryFallbackModel(
      "model-grok-4.6",
      "agent",
      "hackerai-max",
      { hasImageInputs: true },
    );
    expect(text).toBe("model-glm-5.3");
    expect(image).toBe(DEEPSEEK_1017_MODEL_KEY);
    expect(
      buildProviderOptions(true, "user", image, "agent", {
        selectedModelOverride: "hackerai-max",
      }).openrouter.reasoning,
    ).toEqual({ enabled: true, effort: "max" });
    for (const [hasImageInputs, failedModel] of [
      [false, text],
      [true, image],
    ] as const) {
      const recovery = {
        originalModel: "model-grok-4.6",
        failedModel,
        hasImageInputs,
        completedRetryCount: 1,
        selectedModelOverride: "hackerai-max",
        agentModelContextEnabled: true,
        subscription: "ultra" as const,
      };
      expect(
        getNextProviderDisconnectRetryModel({
          ...recovery,
          requiredContextTokens: 10_000,
        }),
      ).toBe("model-grok-4.6");
      expect(
        getNextProviderDisconnectRetryModel({
          ...recovery,
          requiredContextTokens: 400_000,
        }),
      ).toBeUndefined();
      expect(
        getNextProviderDisconnectRetryModel({
          ...recovery,
          completedRetryCount: 2,
          requiredContextTokens: 10_000,
        }),
      ).toBeUndefined();
    }
  });
});

describe("Max measurement boundaries", () => {
  const assignment = {
    key: MAX_GROK_46_KEY,
    variant: "test" as const,
    modelKey: "model-grok-4.6" as const,
    baselineModel: "model-glm-5.3" as const,
    hasImages: false,
  };
  const context = {
    requestId: "run",
    chatId: "chat",
    subscription: "ultra",
    environment: "preview",
    release: "qa-release",
  };
  it("does not call assignment or shared security generations Grok exposure; retries retain attribution", () => {
    const posthog = client("test");
    const recorder = new MaxModelTelemetry(
      posthog as any,
      "user",
      assignment,
      context,
    );
    recorder.providerStarted("abliterated-model-large-flash", false);
    expect(
      posthog.capture.mock.calls.map((c) => (c as any)[0].event),
    ).not.toContain(MAX_GROK_46_EXPOSURE_EVENT);
    recorder.providerStarted("x-ai/grok-4.6", false);
    recorder.providerStarted("z-ai/glm-5.3", false);
    recorder.providerStarted(DEEPSEEK_1017_SLUG, true);
    const exposures = posthog.capture.mock.calls
      .map((c) => (c as any)[0])
      .filter((c) => c.event === MAX_GROK_46_EXPOSURE_EVENT);
    expect(exposures).toHaveLength(1);
    expect(exposures[0].properties).toMatchObject({
      experiment_variant: "test",
      configured_model: "x-ai/grok-4.6",
      exposure_surface: "provider_request",
    });
    expect(recorder.hasImageInputs).toBe(true);
    recorder.recordTerminal({
      outcome: "success",
      naturalCompletion: true,
      responseModel: DEEPSEEK_1017_SLUG,
      recoveryAttempts: 2,
    });
    recorder.recordTerminal({ outcome: "error", naturalCompletion: false });
    const outcomes = posthog.capture.mock.calls
      .map((c) => (c as any)[0])
      .filter((c) => c.event === MAX_GROK_46_OUTCOME_EVENT);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].properties).toMatchObject({
      experiment_variant: "test",
      exposed_to_assigned_model: true,
      provider_attempt_count: 4,
      response_model: DEEPSEEK_1017_SLUG,
      observed_cost_dollars: null,
      cost_reporting_complete: false,
    });
  });
  it("does not count a text control recovery as baseline exposure", () => {
    const posthog = client("control");
    const recorder = new MaxModelTelemetry(
      posthog as any,
      "user",
      { ...assignment, variant: "control", modelKey: "model-glm-5.3" },
      context,
    );
    recorder.providerStarted(DEEPSEEK_1017_SLUG, false);
    expect(recorder.hasAssignedExposure).toBe(false);
    recorder.providerStarted("z-ai/glm-5.3", false);
    expect(recorder.hasAssignedExposure).toBe(true);
  });
  it("keeps the bounded final recovery when an image appears during GLM recovery", () => {
    const recorder = new MaxModelTelemetry(
      client("test") as any,
      "user",
      assignment,
      context,
    );
    recorder.providerStarted("x-ai/grok-4.6", false);
    recorder.providerStarted("z-ai/glm-5.3", true);
    expect(recorder.hasImageInputs).toBe(true);
    expect(
      getNextProviderDisconnectRetryModel({
        originalModel: assignment.modelKey,
        failedModel: "model-glm-5.3",
        completedRetryCount: 1,
        selectedModelOverride: "hackerai-max",
        requiredContextTokens: 10_000,
        agentModelContextEnabled: true,
        subscription: "ultra",
      }),
    ).toBe("model-grok-4.6");
  });
  it.each([false, true])(
    "requires every model and summary record to report cache usage (model covered=%s)",
    (modelCovered) => {
      const posthog = client("test");
      const recorder = new MaxModelTelemetry(
        posthog as any,
        "user",
        assignment,
        context,
      );
      const usage = new UsageTracker();
      usage.recordModelCall();
      recorder.providerStarted("x-ai/grok-4.6", false);
      usage.accumulateStep(
        {
          inputTokens: 20,
          outputTokens: 2,
          ...(modelCovered
            ? { inputTokenDetails: { cacheReadTokens: 0 } }
            : {}),
        },
        "model-grok-4.6",
      );
      usage.accumulateSummarization({
        inputTokens: 10,
        outputTokens: 1,
        inputTokensReported: true,
        cacheReadTokens: 0,
        cost: 0.01,
        model: "model-grok-4.6",
      });
      recorder.recordTerminal({
        outcome: "success",
        naturalCompletion: true,
        usage: usage.measurementProperties("model-grok-4.6"),
      });
      expect(
        (posthog.capture.mock.calls.at(-1) as any)[0].properties
          .cost_reporting_complete,
      ).toBe(modelCovered);
    },
  );
  it("retains pre-model failures and treats absent usage as unknown", () => {
    const posthog = client("test");
    const recorder = new MaxModelTelemetry(
      posthog as any,
      "user",
      assignment,
      context,
    );
    recorder.recordTerminal({
      outcome: "error",
      naturalCompletion: false,
      prompt: "PRIVATE_PROMPT",
      target: "PRIVATE_TARGET",
    } as any);
    const event = (posthog.capture.mock.calls.at(-1) as any)[0];
    expect(event.properties).toMatchObject({
      exposed_to_assigned_model: false,
      provider_attempt_count: 0,
      observed_cost_dollars: null,
      cost_reporting_complete: false,
      natural_completion: false,
    });
    expect(JSON.stringify(posthog.capture.mock.calls)).not.toContain(
      "PRIVATE_",
    );
  });
  it("observes control vision without relabeling it as Grok, and capture failure cannot stop a request", () => {
    const posthog = client("control");
    const recorder = new MaxModelTelemetry(
      posthog as any,
      "user",
      {
        ...assignment,
        variant: "control",
        baselineModel: DEEPSEEK_1017_MODEL_KEY,
        modelKey: DEEPSEEK_1017_MODEL_KEY,
        hasImages: true,
      },
      context,
    );
    recorder.providerStarted(DEEPSEEK_1017_SLUG, true);
    const event = posthog.capture.mock.calls
      .map((c) => (c as any)[0])
      .find((c) => c.event === MAX_GROK_46_EXPOSURE_EVENT);
    expect(event.properties).toMatchObject({
      experiment_variant: "control",
      configured_model: DEEPSEEK_1017_SLUG,
      has_image_inputs: true,
    });
    posthog.capture.mockImplementation(() => {
      throw Error("analytics unavailable");
    });
    expect(() =>
      recorder.recordTerminal({ outcome: "aborted", naturalCompletion: false }),
    ).not.toThrow();
  });
});
