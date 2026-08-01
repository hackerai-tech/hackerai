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
const KIMI_K3_SLUG = "moonshotai/kimi-k3";
const GLM_SLUG = "z-ai/glm-5.2";
const DEEPSEEK_FLASH_SLUG = "deepseek/deepseek-v4-flash-0731";
const DEEPSEEK_FLASH_CANONICAL_SLUG = "deepseek/deepseek-v4-flash-20260731";
const GROK_PRIMARY_OR_FALLBACK_MODELS = [
  "ask-model",
  "ask-model-free",
  "agent-model",
  "agent-model-free",
  "model-grok-4.5",
  "model-grok-4.5-pro",
  "model-deepseek-v4-pro",
  "model-opus-4.6",
  "model-glm-5.2",
  "model-kimi-k3",
  "fallback-agent-model",
  "fallback-ask-model",
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

  it("resolves Opus 4.6 ask chain to Kimi K3 then Grok", () => {
    const opts = buildProviderOptions(false, "user-1", "model-opus-4.6", "ask");
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_K3_SLUG, GROK_SLUG],
      user: "user-1",
    });
  });

  it("resolves Opus 4.6 text-only agent chain to Kimi K3 then Grok", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-opus-4.6",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_K3_SLUG, GROK_SLUG],
      user: "user-1",
    });
  });

  it("resolves Opus 4.6 multimodal agent chain to Kimi K3 then Grok", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-opus-4.6",
      "agent",
      { hasMultimodalToolResults: true },
    );
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_K3_SLUG, GROK_SLUG],
      user: "user-1",
    });
  });

  it("resolves GLM 5.2 to Kimi K3 then Grok", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-glm-5.2",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_K3_SLUG, GROK_SLUG],
      user: "user-1",
    });
  });

  it("resolves Kimi K3 fallback through the active Grok route", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-kimi-k3",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      models: [GROK_SLUG],
      user: "user-1",
    });
  });

  it("falls back from the Grok-backed auto agent route to Kimi K3", () => {
    const opts = buildProviderOptions(false, "user-1", "agent-model", "agent");
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_K3_SLUG],
      user: "user-1",
    });
  });

  it.each(["ask", "agent"] as const)(
    "falls back from HackerAI Pro Grok 4.5 to GLM 5.2 then Kimi K3 in %s mode",
    (mode) => {
      const opts = buildProviderOptions(
        mode === "agent",
        "user-1",
        "model-grok-4.5-pro",
        mode,
      );
      expect(opts.openrouter).toMatchObject({
        reasoning: { enabled: true, effort: "high" },
        models: [GLM_SLUG, KIMI_K3_SLUG],
        user: "user-1",
      });
    },
  );

  it("keeps the Standard Agent media route on its direct Kimi K3 fallback", () => {
    const opts = buildProviderOptions(
      true,
      "user-1",
      "model-grok-4.5",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_K3_SLUG],
      user: "user-1",
    });
  });

  it("falls back from free Ask DeepSeek through Grok then Kimi K3", () => {
    const opts = buildProviderOptions(false, "user-1", "ask-model-free", "ask");
    expect(opts.openrouter).toMatchObject({
      models: [GROK_SLUG, KIMI_K3_SLUG],
      user: "user-1",
    });
  });

  it("runs free Agent on DeepSeek Flash high and falls back through Grok then Kimi K3", () => {
    const opts = buildProviderOptions(
      true,
      "user-1",
      "agent-model-free",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      reasoning: { enabled: true, effort: "high" },
      models: [GROK_SLUG, KIMI_K3_SLUG],
      user: "user-1",
    });
  });

  it("falls back from explicit DeepSeek Pro ask model through Grok then Kimi K3", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-deepseek-v4-pro",
      "ask",
    );
    expect(opts.openrouter).toMatchObject({
      models: [GROK_SLUG, KIMI_K3_SLUG],
      user: "user-1",
    });
  });

  it("falls back from the Grok-backed paid Ask image route to Kimi K3", () => {
    const opts = buildProviderOptions(false, "user-1", "ask-model", "ask");
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_K3_SLUG],
      user: "user-1",
    });
  });

  it("falls back from paid Ask PDF Grok route to Kimi K3", () => {
    const opts = buildProviderOptions(false, "user-1", "model-grok-4.5", "ask");
    expect(opts.openrouter).toMatchObject({
      reasoning: { enabled: true, effort: "high" },
      models: [KIMI_K3_SLUG],
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

  it("uses high reasoning when free Ask can fall back to Grok", () => {
    const opts = buildProviderOptions(false, "user-1", "ask-model-free", "ask");
    expect(opts.openrouter.reasoning).toEqual({
      enabled: true,
      effort: "high",
    });
  });

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
    expect(opts.openrouter.models).toEqual([GROK_SLUG, KIMI_K3_SLUG]);
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

  it.each(["model-deepseek-v4-pro", "ask-model", "model-grok-4.5"])(
    "enables high reasoning for Grok-backed ask mode model %s",
    (modelName) => {
      const opts = buildProviderOptions(false, "user-1", modelName, "ask");
      expect(opts.openrouter.reasoning).toEqual({
        enabled: true,
        effort: "high",
      });
    },
  );

  it.each(["model-grok-4.5-pro", "model-glm-5.2", "model-opus-4.6"])(
    "enables high reasoning for ask mode model %s",
    (modelName) => {
      const opts = buildProviderOptions(false, "user-1", modelName, "ask");
      expect(opts.openrouter.reasoning).toEqual({
        enabled: true,
        effort: "high",
      });
    },
  );

  it.each(["model-grok-4.5-pro", "model-glm-5.2", "model-opus-4.6"])(
    "enables high reasoning for agent mode model %s",
    (modelName) => {
      const opts = buildProviderOptions(true, "user-1", modelName, "agent");
      expect(opts.openrouter.reasoning).toEqual({
        enabled: true,
        effort: "high",
      });
    },
  );

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
      models: [KIMI_K3_SLUG, GROK_SLUG],
    });

    const grokReasoning = buildProviderOptions(
      false,
      "user-1",
      "agent-model",
      "agent",
    );
    expect(grokReasoning.openrouter).toMatchObject({
      reasoning: { enabled: true, effort: "high" },
      models: [KIMI_K3_SLUG],
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
      models: [KIMI_K3_SLUG, GROK_SLUG],
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
  it("uses Grok for app-side retry after free Ask DeepSeek fails", () => {
    expect(getRetryFallbackModel("ask-model-free", "ask")).toBe(
      "model-grok-4.5",
    );
  });

  it("retries free Agent DeepSeek Flash with Grok", () => {
    expect(getRetryFallbackModel("agent-model-free", "agent")).toBe(
      "model-grok-4.5",
    );
  });

  it("retries the Grok-backed paid Ask image route with Kimi K3", () => {
    expect(getRetryFallbackModel("ask-model", "ask")).toBe("model-kimi-k3");
  });

  it.each(["ask", "agent"] as const)(
    "retries Opus 4.6 with Kimi K3 in %s mode",
    (mode) => {
      expect(getRetryFallbackModel("model-opus-4.6", mode)).toBe(
        "model-kimi-k3",
      );
    },
  );

  it("retries HackerAI Pro Grok with GLM 5.2", () => {
    expect(getRetryFallbackModel("model-grok-4.5-pro", "agent")).toBe(
      "model-glm-5.2",
    );
    expect(getRetryFallbackModel("model-grok-4.5-pro", "ask")).toBe(
      "model-glm-5.2",
    );
  });

  it("retries the Standard Agent media route with Kimi K3", () => {
    expect(getRetryFallbackModel("model-grok-4.5", "agent")).toBe(
      "model-kimi-k3",
    );
  });

  it("retries paid DeepSeek Pro with Grok", () => {
    expect(getRetryFallbackModel("model-deepseek-v4-pro", "ask")).toBe(
      "model-grok-4.5",
    );
  });

  it("retries Kimi K3 with the active Grok route", () => {
    expect(getRetryFallbackModel("model-kimi-k3", "agent")).toBe(
      "model-grok-4.5",
    );
  });

  it("retries the Grok-backed paid Ask route with Kimi K3", () => {
    expect(getRetryFallbackModel("model-grok-4.5", "ask")).toBe(
      "model-kimi-k3",
    );
  });
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

  it("maps OpenRouter's canonical DeepSeek Flash 0731 slug to its cost key", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "agent-model-free",
        responseModel: DEEPSEEK_FLASH_CANONICAL_SLUG,
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

  it("maps a Kimi K3 slug served from free Agent fallback back to the local cost key", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "agent-model-free",
        responseModel: KIMI_K3_SLUG,
        mode: "agent",
      }),
    ).toBe("model-kimi-k3");
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

  it("maps a Grok slug served from Kimi K3 fallback to the active cost key", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-kimi-k3",
        responseModel: GROK_SLUG,
        mode: "agent",
      }),
    ).toBe("model-grok-4.5");
  });

  it("maps the dated Kimi K3 provider slug back to the Kimi K3 cost key", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-does-not-exist",
        responseModel: "moonshotai/kimi-k3-20260715",
        mode: "agent",
      }),
    ).toBe("model-kimi-k3");
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
        responseModel: KIMI_K3_SLUG,
        mode: "agent",
      }),
    ).toBe("model-kimi-k3");
  });

  it("maps Standard Agent media Kimi K3 fallback usage back to its cost key", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-grok-4.5",
        responseModel: KIMI_K3_SLUG,
        mode: "agent",
      }),
    ).toBe("model-kimi-k3");
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
