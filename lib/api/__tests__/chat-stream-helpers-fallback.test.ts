/**
 * Tests for the DeepSeek-only provider option / retry helpers.
 *
 * With a single direct DeepSeek provider there is no cross-provider
 * fallback chain and no per-request reasoning-effort dial (those were
 * OpenRouter-specific). These helpers now degrade to simple pass-throughs;
 * these tests lock in that behavior.
 */

import {
  buildProviderOptions,
  getRetryFallbackModel,
  isAutoModelSelectionForRetry,
  resolveServedModelForCostAccounting,
} from "@/lib/api/chat-stream-helpers";

jest.mock("@/lib/db/actions", () => ({
  getNotes: jest.fn(),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

describe("buildProviderOptions", () => {
  it("returns an empty object regardless of inputs", () => {
    expect(
      buildProviderOptions(false, "user-1", "model-opus-4.6", "ask"),
    ).toEqual({});
    expect(
      buildProviderOptions(true, "user-1", "agent-model", "agent"),
    ).toEqual({});
    expect(buildProviderOptions(false)).toEqual({});
  });
});

describe("isAutoModelSelectionForRetry", () => {
  it("keeps paid ask Auto retryable after it resolves to explicit DeepSeek Pro", () => {
    expect(
      isAutoModelSelectionForRetry({
        selectedModel: "model-deepseek-v4-pro",
        selectedModelOverride: "auto",
      }),
    ).toBe(true);
  });

  it("treats missing paid model override as Auto even with an explicit provider key", () => {
    expect(
      isAutoModelSelectionForRetry({
        selectedModel: "model-deepseek-v4-pro",
      }),
    ).toBe(true);
  });

  it("does not treat explicit paid Standard or Pro selections as Auto", () => {
    expect(
      isAutoModelSelectionForRetry({
        selectedModel: "model-deepseek-v4-pro",
        selectedModelOverride: "hackerai-standard",
      }),
    ).toBe(false);
    expect(
      isAutoModelSelectionForRetry({
        selectedModel: "model-sonnet-4.6",
        selectedModelOverride: "hackerai-pro",
      }),
    ).toBe(false);
  });

  it("preserves retry behavior for legacy auto-router model keys", () => {
    expect(
      isAutoModelSelectionForRetry({
        selectedModel: "ask-model-free",
        selectedModelOverride: "hackerai-standard",
      }),
    ).toBe(true);
  });
});

describe("getRetryFallbackModel", () => {
  it("returns the same model — there is no other provider to fall back to", () => {
    expect(getRetryFallbackModel("ask-model-free", "ask")).toBe(
      "ask-model-free",
    );
    expect(getRetryFallbackModel("model-opus-4.6", "agent")).toBe(
      "model-opus-4.6",
    );
    expect(getRetryFallbackModel("agent-model-free")).toBe("agent-model-free");
  });
});

describe("resolveServedModelForCostAccounting", () => {
  it("falls back to the active model key when provider metadata is absent", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "agent-model-free",
      }),
    ).toBe("agent-model-free");
  });

  it("returns the requested model key when the response slug matches it", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "agent-model-free",
        responseModel: "deepseek-v4-flash",
      }),
    ).toBe("agent-model-free");
  });

  it("returns the raw response model when it does not match the requested slug", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "agent-model-free",
        responseModel: "some-other-served-model",
      }),
    ).toBe("some-other-served-model");
  });
});
