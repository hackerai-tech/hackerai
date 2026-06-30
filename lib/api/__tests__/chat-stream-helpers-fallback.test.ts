/**
 * Tests for buildProviderOptions fallback-chain resolution.
 *
 * Verifies that MODEL_FALLBACK_CHAIN entries (declared as registry keys) are
 * resolved to OpenRouter slugs via myProvider.languageModel(...).modelId, and
 * that the function fails closed (no fallback, no throw) for unknown keys.
 */

import {
  buildProviderOptions,
  getRetryFallbackModel,
  isAutoModelSelectionForRetry,
} from "@/lib/api/chat-stream-helpers";

jest.mock("@/lib/db/actions", () => ({
  getNotes: jest.fn(),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

// Slugs the test asserts against. These match the registry in lib/ai/providers.ts.
// If the registry slug for a model changes, update both places intentionally.
const GROK_SLUG = "x-ai/grok-4.3";
const MINIMAX_SLUG = "minimax/minimax-m3";
const KIMI_SLUG = "moonshotai/kimi-k2.7-code:exacto";

describe("buildProviderOptions fallback chain", () => {
  it("resolves Opus 4.6 ask chain to Grok", () => {
    const opts = buildProviderOptions(false, "user-1", "model-opus-4.6", "ask");
    expect(opts.openrouter).toMatchObject({
      models: [GROK_SLUG],
      user: "user-1",
    });
  });

  it("resolves Opus 4.6 text-only agent chain to MiniMax, Kimi 2.7 Code, then Grok slugs", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-opus-4.6",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      models: [MINIMAX_SLUG, KIMI_SLUG, GROK_SLUG],
      user: "user-1",
    });
  });

  it("resolves Opus 4.6 multimodal agent chain to Kimi 2.7 Code then Grok", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-opus-4.6",
      "agent",
      { hasMultimodalToolResults: true },
    );
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_SLUG, GROK_SLUG],
      user: "user-1",
    });
  });

  it("resolves Sonnet 4.6 ask chain to Grok", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-sonnet-4.6",
      "ask",
    );
    expect(opts.openrouter).toMatchObject({
      models: [GROK_SLUG],
      user: "user-1",
    });
  });

  it("resolves Sonnet 4.6 text-only agent chain to MiniMax, Kimi 2.7 Code, then Grok slugs", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-sonnet-4.6",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      models: [MINIMAX_SLUG, KIMI_SLUG, GROK_SLUG],
      user: "user-1",
    });
  });

  it("resolves Sonnet 4.6 multimodal agent chain to Kimi 2.7 Code then Grok", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-sonnet-4.6",
      "agent",
      { hasMultimodalToolResults: true },
    );
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_SLUG, GROK_SLUG],
      user: "user-1",
    });
  });

  it("keeps Anthropic multimodal agent fallback off MiniMax once image tool results exist", () => {
    const opus = buildProviderOptions(
      false,
      "user-1",
      "model-opus-4.6",
      "agent",
      {
        hasMultimodalToolResults: true,
      },
    );
    const sonnet = buildProviderOptions(
      false,
      "user-1",
      "model-sonnet-4.6",
      "agent",
      { hasMultimodalToolResults: true },
    );

    expect(opus.openrouter.models).toEqual([KIMI_SLUG, GROK_SLUG]);
    expect(sonnet.openrouter.models).toEqual([KIMI_SLUG, GROK_SLUG]);
    expect(opus.openrouter.models).not.toContain(MINIMAX_SLUG);
    expect(sonnet.openrouter.models).not.toContain(MINIMAX_SLUG);
  });

  it("falls back from auto agent MiniMax to Kimi 2.7 Code then Grok", () => {
    const opts = buildProviderOptions(false, "user-1", "agent-model", "agent");
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_SLUG, GROK_SLUG],
      user: "user-1",
    });
  });

  it("falls back from explicit MiniMax to Kimi 2.7 Code then Grok", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-minimax-m3",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_SLUG, GROK_SLUG],
      user: "user-1",
    });
  });

  it("falls back from explicit Kimi 2.7 Code to Grok", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-kimi-k2.7-code",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      models: [GROK_SLUG],
      user: "user-1",
    });
  });

  it.each([
    ["ask-model-free", "ask"],
    ["model-deepseek-v4-flash", "ask"],
  ] as const)(
    "falls back from free DeepSeek route %s through the paid Agent chain with Kimi 2.7 Code",
    (modelName, mode) => {
      const opts = buildProviderOptions(false, "user-1", modelName, mode);
      expect(opts.openrouter).toMatchObject({
        models: [MINIMAX_SLUG, KIMI_SLUG, GROK_SLUG],
        user: "user-1",
      });
    },
  );

  it("falls back from free Agent MiniMax to Kimi then Grok", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "agent-model-free",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_SLUG, GROK_SLUG],
      user: "user-1",
    });
  });

  it("falls back from explicit DeepSeek Pro ask model through MiniMax, Kimi, then Grok", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-deepseek-v4-pro",
      "ask",
    );
    expect(opts.openrouter).toMatchObject({
      models: [MINIMAX_SLUG, KIMI_SLUG, GROK_SLUG],
      user: "user-1",
    });
  });

  it.each(["ask-model", "model-grok-4.3"] as const)(
    "falls back from paid Ask media route %s through MiniMax, Kimi, then Grok",
    (modelName) => {
      const opts = buildProviderOptions(false, "user-1", modelName, "ask");
      expect(opts.openrouter).toMatchObject({
        models: [MINIMAX_SLUG, KIMI_SLUG, GROK_SLUG],
        user: "user-1",
      });
    },
  );

  it("keeps the stale Gemini media route alias on the active Ask fallback chain", () => {
    const opts = buildProviderOptions(false, "user-1", "model-gemini-3-flash");
    expect(opts.openrouter).toMatchObject({
      models: [MINIMAX_SLUG, KIMI_SLUG, GROK_SLUG],
      user: "user-1",
    });
  });

  it("does not throw for an unknown registry key — no chain, no slug", () => {
    expect(() =>
      buildProviderOptions(false, "user-1", "model-does-not-exist"),
    ).not.toThrow();
    const opts = buildProviderOptions(false, "user-1", "model-does-not-exist");
    expect(opts.openrouter).not.toHaveProperty("models");
  });

  it("emits no `models` field when modelName is omitted", () => {
    const opts = buildProviderOptions(false, "user-1");
    expect(opts.openrouter).not.toHaveProperty("models");
  });

  it.each(["ask-model-free", "model-deepseek-v4-flash"])(
    "keeps reasoning disabled for free/flash ask mode model %s",
    (modelName) => {
      const opts = buildProviderOptions(false, "user-1", modelName, "ask");
      expect(opts.openrouter.reasoning).toEqual({ enabled: false });
    },
  );

  it("allows a scoped reasoning override", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "ask-model-free",
      "ask",
      {
        reasoningOverride: { enabled: true, effort: "medium" },
      },
    );

    expect(opts.openrouter.reasoning).toEqual({
      enabled: true,
      effort: "medium",
    });
    expect(opts.openrouter.models).toEqual([
      MINIMAX_SLUG,
      KIMI_SLUG,
      GROK_SLUG,
    ]);
  });

  it("enables reasoning for the current Kimi 2.7 Code ask route", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-kimi-k2.7-code",
      "ask",
    );
    expect(opts.openrouter.reasoning).toEqual({
      enabled: true,
    });
  });

  it("keeps reasoning enabled for the legacy Kimi 2.6 alias", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-kimi-k2.6",
      "ask",
    );
    expect(opts.openrouter.reasoning).toEqual({
      enabled: true,
    });
  });

  it.each([
    "model-deepseek-v4-pro",
    "ask-model",
    "model-grok-4.3",
    "model-gemini-3-flash",
    "model-sonnet-4.6",
    "model-opus-4.6",
  ])("enables medium reasoning for ask mode model %s", (modelName) => {
    const opts = buildProviderOptions(false, "user-1", modelName, "ask");
    expect(opts.openrouter.reasoning).toEqual({
      enabled: true,
      effort: "medium",
    });
  });

  it("includes reasoning settings independent of fallback chain", () => {
    const reasoning = buildProviderOptions(
      true,
      "user-1",
      "model-opus-4.6",
      "agent",
    );
    expect(reasoning.openrouter).toMatchObject({
      reasoning: { enabled: true },
      models: [MINIMAX_SLUG, KIMI_SLUG, GROK_SLUG],
    });

    const noReasoning = buildProviderOptions(
      false,
      "user-1",
      "model-opus-4.6",
      "agent",
    );
    expect(noReasoning.openrouter).toMatchObject({
      reasoning: { enabled: false },
      models: [MINIMAX_SLUG, KIMI_SLUG, GROK_SLUG],
    });

    const multimodal = buildProviderOptions(
      true,
      "user-1",
      "model-opus-4.6",
      "agent",
      { hasMultimodalToolResults: true },
    );
    expect(multimodal.openrouter).toMatchObject({
      reasoning: { enabled: true },
      models: [KIMI_SLUG, GROK_SLUG],
    });
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
  it.each([
    ["ask-model-free", "ask"],
    ["model-deepseek-v4-flash", "ask"],
  ] as const)(
    "uses the paid Agent fallback chain for app-side retry after free DeepSeek route %s fails",
    (modelName, mode) => {
      expect(getRetryFallbackModel(modelName, mode)).toBe("model-minimax-m3");
    },
  );

  it("keeps free Agent MiniMax app-side retry on the terminal Grok fallback", () => {
    expect(getRetryFallbackModel("agent-model-free", "agent")).toBe(
      "fallback-grok-4.3",
    );
  });

  it.each([
    ["model-deepseek-v4-pro", "ask"],
    ["ask-model", "ask"],
    ["model-grok-4.3", "ask"],
    ["model-gemini-3-flash", "ask"],
  ] as const)(
    "uses the paid Agent fallback chain for app-side retry after paid Ask route %s fails",
    (modelName, mode) => {
      expect(getRetryFallbackModel(modelName, mode)).toBe("model-minimax-m3");
    },
  );
});
