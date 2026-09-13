import { describe, expect, it } from "@jest/globals";
import {
  KIMI_MAX_REASONING_EFFORT,
  shouldUseMaxKimiReasoning,
} from "../kimi-reasoning";

const eligibleRequest = {
  subscription: "pro" as const,
  mode: "agent" as const,
  selectedModel: "model-opus-4.6",
  configuredModelId: "moonshotai/kimi-k3",
};

describe("Kimi reasoning policy", () => {
  it("uses max reasoning as the explicit production default", () => {
    expect(KIMI_MAX_REASONING_EFFORT).toBe("max");
    expect(shouldUseMaxKimiReasoning(eligibleRequest)).toBe(true);
    expect(
      shouldUseMaxKimiReasoning({
        ...eligibleRequest,
        selectedModel: "model-kimi-k3",
      }),
    ).toBe(true);
  });

  it("limits max reasoning to paid individual Max Agent requests served by Kimi", () => {
    expect(
      shouldUseMaxKimiReasoning({
        ...eligibleRequest,
        subscription: "free",
      }),
    ).toBe(false);
    expect(
      shouldUseMaxKimiReasoning({
        ...eligibleRequest,
        subscription: "team",
      }),
    ).toBe(false);
    expect(
      shouldUseMaxKimiReasoning({
        ...eligibleRequest,
        mode: "ask",
      }),
    ).toBe(false);
    expect(
      shouldUseMaxKimiReasoning({
        ...eligibleRequest,
        selectedModel: "agent-model",
      }),
    ).toBe(false);
    expect(
      shouldUseMaxKimiReasoning({
        ...eligibleRequest,
        configuredModelId: "x-ai/grok-4.6",
      }),
    ).toBe(false);
  });
});
