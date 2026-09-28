jest.mock("server-only", () => ({}));

import { describe, expect, it } from "@jest/globals";
import { selectModel } from "@/lib/chat/chat-processor";
import {
  getContentFilterRetryModel,
  getRetryFallbackModel,
  resolveServedModelForCostAccounting,
} from "@/lib/api/chat-stream-helpers";
import { getModelDisplayName } from "@/lib/ai/providers";
import { calculateRawModelUsageCostDollars } from "@/lib/rate-limit";
import { UsageTracker } from "@/lib/usage-tracker";
import { isEligibleForAbliteratedModel } from "@/lib/experiments/abliterated-model";
import { isEligibleForDirectGlmVision } from "@/lib/chat/auxiliary-vision-eligibility";
import {
  coerceSelectedModel,
  normalizeSelectedModelForMode,
  normalizeSelectedModelForSubscription,
  normalizeSelectedModelOverrideForSubscription,
} from "@/types/chat";

const KEY = "orcarouter:openai/gpt-5.5" as const;

describe("OrcaRouter model routing", () => {
  it("persists and restores only well-formed OrcaRouter selections", () => {
    expect(coerceSelectedModel(KEY)).toBe(KEY);
    expect(coerceSelectedModel("orcarouter:gpt-5.5")).toBeNull();
    expect(coerceSelectedModel("orcarouter:../etc/passwd")).toBeNull();
    expect(coerceSelectedModel("orcarouter:")).toBeNull();
  });

  it("serves an OrcaRouter choice in Ask mode, including the free plan", () => {
    expect(selectModel("ask", "free", KEY)).toBe(KEY);
    expect(selectModel("ask", "pro", KEY, true)).toBe(KEY);
    expect(normalizeSelectedModelForSubscription(KEY, "free")).toBe(KEY);
    expect(normalizeSelectedModelOverrideForSubscription(KEY, "free")).toBe(
      KEY,
    );
    // Free plans still cannot pick HackerAI tiers.
    expect(normalizeSelectedModelForSubscription("hackerai-pro", "free")).toBe(
      "auto",
    );
  });

  it("routes Agent mode as Auto", () => {
    expect(selectModel("agent", "pro", KEY)).toBe(
      selectModel("agent", "pro", "auto"),
    );
    expect(selectModel("agent", "free", KEY)).toBe(
      selectModel("agent", "free", "auto"),
    );
    expect(normalizeSelectedModelForMode(KEY, "agent")).toBe("auto");
    expect(normalizeSelectedModelForMode(KEY, "ask")).toBe(KEY);
  });

  it("never swaps the user's OrcaRouter model for a HackerAI model", () => {
    expect(getRetryFallbackModel(KEY, "ask")).toBe(KEY);
    expect(getContentFilterRetryModel(KEY, "ask", "openai/gpt-5.5")).toBe(KEY);
    expect(
      isEligibleForAbliteratedModel({
        subscription: "pro",
        mode: "ask",
        selectedModelOverride: KEY,
        moderationEligible: true,
        messages: [{ id: "1", role: "user", parts: [] }],
      }),
    ).toBe(false);
    expect(
      isEligibleForDirectGlmVision({
        subscription: "pro",
        selectedModelOverride: KEY,
      }),
    ).toBe(false);
  });

  it("names the OrcaRouter model in the system prompt", () => {
    expect(getModelDisplayName(KEY)).toBe("openai/gpt-5.5 via OrcaRouter");
  });
});

describe("OrcaRouter usage accounting", () => {
  it("does not charge HackerAI usage for OrcaRouter model tokens", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: KEY,
        responseModel: "openai/gpt-5.5",
      }),
    ).toBe(KEY);
    expect(
      calculateRawModelUsageCostDollars({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        modelName: KEY,
      }),
    ).toBe(0);

    const tracker = new UsageTracker();
    tracker.accumulateStep(
      {
        inputTokens: 1_000,
        outputTokens: 500,
        totalTokens: 1_500,
        raw: { cost: 0.42 },
      } as Parameters<UsageTracker["accumulateStep"]>[0],
      KEY,
    );
    expect(tracker.computeModelCostDollars(KEY)).toBe(0);
  });

  it("still charges HackerAI models normally", () => {
    expect(
      calculateRawModelUsageCostDollars({
        inputTokens: 1_000_000,
        outputTokens: 0,
        modelName: "model-glm-5.3",
      }),
    ).toBeGreaterThan(0);
  });
});
