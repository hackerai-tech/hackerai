import {
  FREE_ASK_REASONING_EXPERIMENT_KEY,
  captureFreeAskReasoningExperimentExposure,
  captureFreeAskReasoningExperimentResult,
  resolveFreeAskReasoningExperiment,
} from "@/lib/experiments/free-ask-reasoning";

const ORIGINAL_TREATMENT_PERCENTAGE =
  process.env.FREE_ASK_REASONING_EXPERIMENT_TREATMENT_PERCENTAGE;

afterEach(() => {
  if (ORIGINAL_TREATMENT_PERCENTAGE === undefined) {
    delete process.env.FREE_ASK_REASONING_EXPERIMENT_TREATMENT_PERCENTAGE;
  } else {
    process.env.FREE_ASK_REASONING_EXPERIMENT_TREATMENT_PERCENTAGE =
      ORIGINAL_TREATMENT_PERCENTAGE;
  }
  jest.clearAllMocks();
});

describe("resolveFreeAskReasoningExperiment", () => {
  it("does not assign users outside free text-only Ask", async () => {
    const getFeatureFlag = jest.fn();

    await expect(
      resolveFreeAskReasoningExperiment({
        posthog: { getFeatureFlag } as any,
        userId: "user_123",
        subscription: "pro",
        mode: "ask",
        selectedModel: "model-deepseek-v4-pro",
        fileCount: 0,
      }),
    ).resolves.toBeNull();

    await expect(
      resolveFreeAskReasoningExperiment({
        posthog: { getFeatureFlag } as any,
        userId: "user_123",
        subscription: "free",
        mode: "ask",
        selectedModel: "ask-model-free",
        fileCount: 1,
      }),
    ).resolves.toBeNull();

    expect(getFeatureFlag).not.toHaveBeenCalled();
  });

  it("uses the PostHog variant when the server flag returns one", async () => {
    const getFeatureFlag = jest.fn().mockResolvedValue("reasoning_medium");

    const assignment = await resolveFreeAskReasoningExperiment({
      posthog: { getFeatureFlag } as any,
      userId: "user_123",
      subscription: "free",
      mode: "ask",
      selectedModel: "ask-model-free",
      fileCount: 0,
    });

    expect(getFeatureFlag).toHaveBeenCalledWith(
      FREE_ASK_REASONING_EXPERIMENT_KEY,
      "user_123",
      expect.objectContaining({
        personProperties: expect.objectContaining({
          subscription_tier: "free",
          mode: "ask",
          selected_model: "ask-model-free",
        }),
      }),
    );
    expect(assignment).toMatchObject({
      variant: "reasoning_medium",
      source: "posthog",
      reasoning: { enabled: true, effort: "medium" },
    });
  });

  it("falls back to deterministic env rollout when PostHog is unavailable", async () => {
    process.env.FREE_ASK_REASONING_EXPERIMENT_TREATMENT_PERCENTAGE = "100";

    const assignment = await resolveFreeAskReasoningExperiment({
      posthog: null,
      userId: "user_123",
      subscription: "free",
      mode: "ask",
      selectedModel: "ask-model-free",
      fileCount: 0,
    });

    expect(assignment).toMatchObject({
      variant: "reasoning_medium",
      source: "env",
      treatmentPercentage: 100,
      reasoning: { enabled: true, effort: "medium" },
    });
  });

  it("stays disabled when neither PostHog nor env rollout is active", async () => {
    delete process.env.FREE_ASK_REASONING_EXPERIMENT_TREATMENT_PERCENTAGE;

    await expect(
      resolveFreeAskReasoningExperiment({
        posthog: null,
        userId: "user_123",
        subscription: "free",
        mode: "ask",
        selectedModel: "ask-model-free",
        fileCount: 0,
      }),
    ).resolves.toBeNull();
  });
});

describe("free Ask reasoning PostHog events", () => {
  const assignment = {
    experimentKey: FREE_ASK_REASONING_EXPERIMENT_KEY,
    featureFlagKey: FREE_ASK_REASONING_EXPERIMENT_KEY,
    eventVersion: 1,
    variant: "reasoning_medium" as const,
    source: "posthog" as const,
    reasoning: { enabled: true as const, effort: "medium" as const },
  };

  it("captures exposure with feature flag properties", () => {
    const capture = jest.fn();

    captureFreeAskReasoningExperimentExposure({
      posthog: { capture } as any,
      userId: "user_123",
      chatId: "chat_123",
      subscription: "free",
      mode: "ask",
      selectedModel: "ask-model-free",
      assignment,
      estimatedInputTokens: 123,
      isNewChat: true,
    });

    expect(capture).toHaveBeenCalledWith({
      distinctId: "user_123",
      event: "free_ask_reasoning_experiment_exposed",
      properties: expect.objectContaining({
        user_id: "user_123",
        chat_id: "chat_123",
        subscription_tier: "free",
        selected_model: "ask-model-free",
        estimated_input_tokens: 123,
        experiment_key: FREE_ASK_REASONING_EXPERIMENT_KEY,
        variant: "reasoning_medium",
        reasoning_enabled: true,
        reasoning_effort: "medium",
        [`$feature/${FREE_ASK_REASONING_EXPERIMENT_KEY}`]: "reasoning_medium",
      }),
    });
  });

  it("captures result with outcome and timing", () => {
    const capture = jest.fn();

    captureFreeAskReasoningExperimentResult({
      posthog: { capture } as any,
      userId: "user_123",
      chatId: "chat_123",
      subscription: "free",
      mode: "ask",
      selectedModel: "ask-model-free",
      assignment,
      outcome: "success",
      generationTimeMs: 456,
      finishReason: "stop",
    });

    expect(capture).toHaveBeenCalledWith({
      distinctId: "user_123",
      event: "free_ask_reasoning_experiment_result",
      properties: expect.objectContaining({
        outcome: "success",
        generation_time_ms: 456,
        finish_reason: "stop",
        experiment_key: FREE_ASK_REASONING_EXPERIMENT_KEY,
        variant: "reasoning_medium",
        reasoning_enabled: true,
      }),
    });
  });
});
