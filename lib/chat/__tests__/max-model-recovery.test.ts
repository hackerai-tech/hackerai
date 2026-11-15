import { DEEPSEEK_1017_MODEL_KEY } from "@/lib/experiments/paid-deepseek-1017";
import {
  getRetryFallbackModel,
  buildProviderOptions,
} from "@/lib/api/chat-stream-helpers";
import { getNextProviderDisconnectRetryModel } from "../agent-long-provider-retry";

jest.mock("@/lib/db/actions", () => ({ getNotes: jest.fn() }));

describe("Max model recovery policy", () => {
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
