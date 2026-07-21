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
  resolveServedModelForCostAccounting,
} from "@/lib/api/chat-stream-helpers";

jest.mock("@/lib/db/actions", () => ({
  getNotes: jest.fn(),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

// Slugs the test asserts against. These match the registry in lib/ai/providers.ts.
// If the registry slug for a model changes, update both places intentionally.
const GROK_SLUG = "x-ai/grok-4.5";
const KIMI_SLUG = "moonshotai/kimi-k2.7-code:exacto";
const GLM_SLUG = "z-ai/glm-5.2";
const DEEPSEEK_FLASH_SLUG = "deepseek/deepseek-v4-flash";
const GROK_PRIMARY_OR_FALLBACK_MODELS = [
  "ask-model",
  "ask-model-free",
  "agent-model",
  "agent-model-free",
  "model-sonnet-4.6",
  "model-grok-4.5",
  "model-grok-4.5-pro",
  "model-gemini-3-flash",
  "model-deepseek-v4-flash",
  "model-deepseek-v4-pro",
  "model-opus-4.6",
  "model-glm-5.2",
  "model-minimax-m3",
  "model-kimi-k2.7-code",
  "model-kimi-k2.6",
  "fallback-agent-model",
  "fallback-ask-model",
  "fallback-grok-4.5",
] as const;

describe("buildProviderOptions fallback chain", () => {
  it("keeps title generation on a non-reasoning route", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "title-generator-model",
      "ask",
    );

    expect(opts.openrouter).toEqual({
      reasoning: { enabled: false },
      user: "user-1",
    });
  });

  it.each(GROK_PRIMARY_OR_FALLBACK_MODELS)(
    "uses high reasoning whenever %s can resolve to Grok",
    (modelName) => {
      for (const mode of ["ask", "agent"] as const) {
        const opts = buildProviderOptions(
          mode === "agent",
          "user-1",
          modelName,
          mode,
        );
        expect(opts.openrouter.reasoning).toEqual({
          enabled: true,
          effort: "high",
        });
      }
    },
  );

  it("resolves Opus 4.6 ask chain to Grok", () => {
    const opts = buildProviderOptions(false, "user-1", "model-opus-4.6", "ask");
    expect(opts.openrouter).toMatchObject({
      models: [GROK_SLUG],
      user: "user-1",
    });
  });

  it("resolves Opus 4.6 text-only agent chain to Grok then Kimi 2.7 Code", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-opus-4.6",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      models: [GROK_SLUG, KIMI_SLUG],
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

  it("resolves Sonnet 4.6 text-only agent chain to Grok then Kimi 2.7 Code", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-sonnet-4.6",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      models: [GROK_SLUG, KIMI_SLUG],
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

  it("resolves GLM 5.2 to Kimi 2.7 Code then Grok", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-glm-5.2",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_SLUG, GROK_SLUG],
      user: "user-1",
    });
  });

  it("keeps Anthropic multimodal agent fallback on Kimi then Grok", () => {
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
  });

  it("falls back from the Grok-backed auto agent route to Kimi 2.7 Code", () => {
    const opts = buildProviderOptions(false, "user-1", "agent-model", "agent");
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_SLUG],
      user: "user-1",
    });
  });

  it("keeps the stale MiniMax key on Grok's Kimi fallback", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-minimax-m3",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_SLUG],
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

  it.each(["ask", "agent"] as const)(
    "falls back from HackerAI Pro Grok 4.5 to GLM 5.2 then Kimi in %s mode",
    (mode) => {
      const opts = buildProviderOptions(
        mode === "agent",
        "user-1",
        "model-grok-4.5-pro",
        mode,
      );
      expect(opts.openrouter).toMatchObject({
        reasoning: { enabled: true, effort: "high" },
        models: [GLM_SLUG, KIMI_SLUG],
        user: "user-1",
      });
    },
  );

  it("keeps the legacy Agent vision Grok route on its direct Kimi fallback", () => {
    const opts = buildProviderOptions(
      true,
      "user-1",
      "model-grok-4.5",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_SLUG],
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
        models: [GROK_SLUG, KIMI_SLUG],
        user: "user-1",
      });
    },
  );

  it("runs free Agent on DeepSeek Flash high and falls back through Grok then Kimi", () => {
    const opts = buildProviderOptions(
      true,
      "user-1",
      "agent-model-free",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      reasoning: { enabled: true, effort: "high" },
      models: [GROK_SLUG, KIMI_SLUG],
      user: "user-1",
    });
  });

  it("falls back from explicit DeepSeek Pro ask model through Grok then Kimi", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-deepseek-v4-pro",
      "ask",
    );
    expect(opts.openrouter).toMatchObject({
      models: [GROK_SLUG, KIMI_SLUG],
      user: "user-1",
    });
  });

  it("falls back from the Grok-backed paid Ask image route to Kimi", () => {
    const opts = buildProviderOptions(false, "user-1", "ask-model", "ask");
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_SLUG],
      user: "user-1",
    });
  });

  it("falls back from paid Ask PDF Grok route to Kimi", () => {
    const opts = buildProviderOptions(false, "user-1", "model-grok-4.5", "ask");
    expect(opts.openrouter).toMatchObject({
      reasoning: { enabled: true, effort: "high" },
      models: [KIMI_SLUG],
      user: "user-1",
    });
  });

  it("keeps the stale media route alias on the active Ask fallback chain", () => {
    const opts = buildProviderOptions(false, "user-1", "model-gemini-3-flash");
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_SLUG],
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
    "uses high reasoning when free/flash ask model %s can fall back to Grok",
    (modelName) => {
      const opts = buildProviderOptions(false, "user-1", modelName, "ask");
      expect(opts.openrouter.reasoning).toEqual({
        enabled: true,
        effort: "high",
      });
    },
  );

  it("keeps Grok fallback reasoning high over a lower scoped override", () => {
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
      effort: "high",
    });
    expect(opts.openrouter.models).toEqual([GROK_SLUG, KIMI_SLUG]);
  });

  it("allows a scoped reasoning override when Grok is not in the route", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-does-not-exist",
      "ask",
      {
        reasoningOverride: { enabled: true, effort: "medium" },
      },
    );

    expect(opts.openrouter.reasoning).toEqual({
      enabled: true,
      effort: "medium",
    });
    expect(opts.openrouter).not.toHaveProperty("models");
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
      effort: "high",
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
      effort: "high",
    });
  });

  it.each([
    "model-deepseek-v4-pro",
    "ask-model",
    "model-minimax-m3",
    "model-grok-4.5",
    "model-gemini-3-flash",
    "fallback-grok-4.5",
  ])(
    "enables high reasoning for Grok-backed ask mode model %s",
    (modelName) => {
      const opts = buildProviderOptions(false, "user-1", modelName, "ask");
      expect(opts.openrouter.reasoning).toEqual({
        enabled: true,
        effort: "high",
      });
    },
  );

  it.each([
    "model-grok-4.5-pro",
    "model-glm-5.2",
    "model-sonnet-4.6",
    "model-opus-4.6",
  ])("enables high reasoning for ask mode model %s", (modelName) => {
    const opts = buildProviderOptions(false, "user-1", modelName, "ask");
    expect(opts.openrouter.reasoning).toEqual({
      enabled: true,
      effort: "high",
    });
  });

  it.each([
    "model-grok-4.5-pro",
    "model-glm-5.2",
    "model-sonnet-4.6",
    "model-opus-4.6",
  ])("enables high reasoning for agent mode model %s", (modelName) => {
    const opts = buildProviderOptions(true, "user-1", modelName, "agent");
    expect(opts.openrouter.reasoning).toEqual({
      enabled: true,
      effort: "high",
    });
  });

  it("uses high reasoning for DeepSeek V4 Pro in agent mode", () => {
    const opts = buildProviderOptions(
      true,
      "user-1",
      "model-deepseek-v4-pro",
      "agent",
    );
    expect(opts.openrouter.reasoning).toEqual({
      enabled: true,
      effort: "high",
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
      reasoning: { enabled: true, effort: "high" },
      models: [GROK_SLUG, KIMI_SLUG],
    });

    const grokReasoning = buildProviderOptions(
      false,
      "user-1",
      "agent-model",
      "agent",
    );
    expect(grokReasoning.openrouter).toMatchObject({
      reasoning: { enabled: true, effort: "high" },
      models: [KIMI_SLUG],
    });

    const multimodal = buildProviderOptions(
      true,
      "user-1",
      "model-opus-4.6",
      "agent",
      { hasMultimodalToolResults: true },
    );
    expect(multimodal.openrouter).toMatchObject({
      reasoning: { enabled: true, effort: "high" },
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
        selectedModel: "model-grok-4.5-pro",
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
      expect(getRetryFallbackModel(modelName, mode)).toBe("model-grok-4.5");
    },
  );

  it("retries free Agent DeepSeek Flash with Grok", () => {
    expect(getRetryFallbackModel("agent-model-free", "agent")).toBe(
      "model-grok-4.5",
    );
  });

  it("retries the Grok-backed paid Ask image route with Kimi", () => {
    expect(getRetryFallbackModel("ask-model", "ask")).toBe(
      "model-kimi-k2.7-code",
    );
  });

  it("retries HackerAI Pro Grok with GLM 5.2", () => {
    expect(getRetryFallbackModel("model-grok-4.5-pro", "agent")).toBe(
      "model-glm-5.2",
    );
    expect(getRetryFallbackModel("model-grok-4.5-pro", "ask")).toBe(
      "model-glm-5.2",
    );
  });

  it("retries the legacy Agent vision Grok route with Kimi 2.7 Code", () => {
    expect(getRetryFallbackModel("model-grok-4.5", "agent")).toBe(
      "model-kimi-k2.7-code",
    );
  });

  it("retries paid DeepSeek Pro with Grok", () => {
    expect(getRetryFallbackModel("model-deepseek-v4-pro", "ask")).toBe(
      "model-grok-4.5",
    );
  });

  it.each([
    ["model-grok-4.5", "ask"],
    ["model-gemini-3-flash", "ask"],
  ] as const)(
    "retries Grok-backed paid Ask route %s with Kimi",
    (modelName, mode) => {
      expect(getRetryFallbackModel(modelName, mode)).toBe(
        "model-kimi-k2.7-code",
      );
    },
  );
});

describe("resolveServedModelForCostAccounting", () => {
  it("maps the primary free Agent DeepSeek slug back to its local cost key", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "agent-model-free",
        responseModel: DEEPSEEK_FLASH_SLUG,
        mode: "agent",
      }),
    ).toBe("agent-model-free");
  });

  it("maps a Grok slug served from free Agent fallback back to the local cost key", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "agent-model-free",
        responseModel: GROK_SLUG,
        mode: "agent",
      }),
    ).toBe("model-grok-4.5");
  });

  it("maps a Kimi provider slug served from free Agent fallback back to the local cost key", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "agent-model-free",
        responseModel: KIMI_SLUG,
        mode: "agent",
      }),
    ).toBe("model-kimi-k2.7-code");
  });

  it("maps a direct Grok provider slug back to the Grok 4.5 cost key", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-does-not-exist",
        responseModel: GROK_SLUG,
        mode: "ask",
      }),
    ).toBe("model-grok-4.5");
  });

  it("maps HackerAI Pro primary and fallback usage to their exact cost keys", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-grok-4.5-pro",
        responseModel: GROK_SLUG,
        mode: "agent",
      }),
    ).toBe("model-grok-4.5-pro");
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-grok-4.5-pro",
        responseModel: GLM_SLUG,
        mode: "ask",
      }),
    ).toBe("model-glm-5.2");
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-grok-4.5-pro",
        responseModel: KIMI_SLUG,
        mode: "agent",
      }),
    ).toBe("model-kimi-k2.7-code");
  });

  it("maps legacy Agent Pro vision Kimi fallback usage back to the Kimi cost key", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-grok-4.5",
        responseModel: KIMI_SLUG,
        mode: "agent",
      }),
    ).toBe("model-kimi-k2.7-code");
  });

  it("maps dated Opus provider response slugs back to the local cost key", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-opus-4.6",
        responseModel: "anthropic/claude-4.6-opus-20260205",
        mode: "agent",
      }),
    ).toBe("model-opus-4.6");
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-opus-4.6",
        responseModel: "anthropic/claude-4.6-opus-20261231",
        mode: "agent",
      }),
    ).toBe("model-opus-4.6");
  });

  it("maps dated Sonnet provider response slugs back to the local cost key", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-sonnet-4.6",
        responseModel: "anthropic/claude-4.6-sonnet-20260217",
        mode: "ask",
      }),
    ).toBe("model-sonnet-4.6");
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-sonnet-4.6",
        responseModel: "anthropic/claude-4.6-sonnet-20261231",
        mode: "ask",
      }),
    ).toBe("model-sonnet-4.6");
  });

  it("maps GLM provider response slugs back to the local cost key", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-glm-5.2",
        responseModel: GLM_SLUG,
        mode: "agent",
      }),
    ).toBe("model-glm-5.2");
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-glm-5.2",
        responseModel: "z-ai/glm-5.2-20260616",
        mode: "ask",
      }),
    ).toBe("model-glm-5.2");
  });

  it("falls back to the active model key when provider metadata is absent", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "agent-model-free",
        mode: "agent",
      }),
    ).toBe("agent-model-free");
  });
});
