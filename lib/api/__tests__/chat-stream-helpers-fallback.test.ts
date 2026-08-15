/**
 * Tests for buildProviderOptions fallback-chain resolution.
 *
 * Verifies that MODEL_FALLBACK_CHAIN entries (declared as registry keys) are
 * resolved to OpenRouter slugs via myProvider.languageModel(...).modelId, and
 * that the function fails closed (no fallback, no throw) for unknown keys.
 */

import {
  buildProviderOptions,
  getContentFilterRetryModel,
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
const GROK_4_5_SLUG = "x-ai/grok-4.5";
const GROK_SLUG = "x-ai/grok-4.6";
const KIMI_K3_SLUG = "moonshotai/kimi-k3";
const GLM_SLUG = "z-ai/glm-5.2";
const DEEPSEEK_FLASH_SLUG = "deepseek/deepseek-v4-flash-0731";
const DEEPSEEK_FLASH_CANONICAL_SLUG = "deepseek/deepseek-v4-flash-20260731";
const DEEPSEEK_FLASH_PREVIOUS_SLUG = "deepseek/deepseek-v4-flash";
const DEEPSEEK_FLASH_PREVIOUS_CANONICAL_SLUG =
  "deepseek/deepseek-v4-flash-20260423";
const DEEPSEEK_V4_PRO_0813_SLUG = "deepseek/deepseek-v4-pro-0813";
const HIGH_REASONING_ROUTES = [
  "ask-model",
  "agent-model",
  "agent-model-free",
  "model-grok-4.5-pro",
  "model-grok-4.6",
  "model-grok-4.6-pro",
  "model-deepseek-v4-flash-0731",
  "model-deepseek-v4-pro",
  "model-deepseek-v4-pro-0813",
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
      provider: { ignore: ["novita"] },
      user: "user-1",
    });
  });

  it("ignores Novita only for the previous DeepSeek Flash route", () => {
    const previousRoute = buildProviderOptions(
      false,
      "user-1",
      "ask-model-free",
      "ask",
      { requestedModelSlug: DEEPSEEK_FLASH_PREVIOUS_SLUG },
    );
    const currentRoute = buildProviderOptions(
      false,
      "user-1",
      "ask-model-free",
      "ask",
      { requestedModelSlug: DEEPSEEK_FLASH_SLUG },
    );

    expect(previousRoute.openrouter.provider).toEqual({
      ignore: ["novita"],
    });
    expect(currentRoute.openrouter).not.toHaveProperty("provider");
  });

  it.each(HIGH_REASONING_ROUTES)(
    "uses high reasoning for paid or Grok-reachable route %s",
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

  it("resolves the Max Kimi K3 ask route to Grok fallback", () => {
    const opts = buildProviderOptions(false, "user-1", "model-opus-4.6", "ask");
    expect(opts.openrouter).toMatchObject({
      models: [GROK_SLUG],
      user: "user-1",
    });
  });

  it("resolves the Max Kimi K3 text-only agent route to Grok fallback", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-opus-4.6",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      models: [GROK_SLUG],
      user: "user-1",
    });
  });

  it("resolves the Max Kimi K3 multimodal agent route to Grok fallback", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-opus-4.6",
      "agent",
      { hasMultimodalToolResults: true },
    );
    expect(opts.openrouter).toMatchObject({
      models: [GROK_SLUG],
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

  it("excludes the model that actually returned content-filter from retry fallbacks", () => {
    const opts = buildProviderOptions(
      true,
      "user-1",
      "model-grok-4.6-pro",
      "agent",
      { excludedModelSlugs: ["z-ai/glm-5.2-20260616"] },
    );

    expect(opts.openrouter).toMatchObject({
      models: [KIMI_K3_SLUG],
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
    "falls back from HackerAI Pro Grok 4.6 to GLM 5.2 then Kimi K3 in %s mode",
    (mode) => {
      const opts = buildProviderOptions(
        mode === "agent",
        "user-1",
        "model-grok-4.6-pro",
        mode,
      );
      expect(opts.openrouter).toMatchObject({
        reasoning: { enabled: true, effort: "high" },
        models: [GLM_SLUG, KIMI_K3_SLUG],
        user: "user-1",
      });
    },
  );

  it("routes Pro vision through Grok 4.5 high with Kimi K3 fallback", () => {
    const opts = buildProviderOptions(
      true,
      "user-1",
      "model-grok-4.5-pro",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      reasoning: { enabled: true, effort: "high" },
      models: [KIMI_K3_SLUG],
      user: "user-1",
    });
  });

  it("routes Standard vision through Grok 4.5 medium with Kimi K3 fallback", () => {
    const opts = buildProviderOptions(
      true,
      "user-1",
      "model-grok-4.5",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      reasoning: { enabled: true, effort: "medium" },
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

  it.each([
    "model-deepseek-v4-flash-0731",
    "model-deepseek-v4-pro-0813",
  ] as const)(
    "enables OpenRouter Mistral OCR for PDFs sent to %s",
    (modelName) => {
      const opts = buildProviderOptions(false, "user-1", modelName, "agent", {
        hasPdfAttachments: true,
      });

      expect(opts.openrouter.plugins).toEqual([
        { id: "file-parser", pdf: { engine: "mistral-ocr" } },
      ]);
    },
  );

  it("does not enable the PDF parser when a DeepSeek request has no PDF", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-deepseek-v4-flash-0731",
      "agent",
    );

    expect(opts.openrouter).not.toHaveProperty("plugins");
  });

  it("falls back from DeepSeek V4 Flash 0731 through Pro 0813, Grok, then Kimi K3", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-deepseek-v4-flash-0731",
      "ask",
    );
    expect(opts.openrouter).toMatchObject({
      reasoning: { enabled: true, effort: "high" },
      models: [DEEPSEEK_V4_PRO_0813_SLUG, GROK_SLUG, KIMI_K3_SLUG],
      user: "user-1",
    });
  });

  it("falls back from DeepSeek V4 Pro 0813 through Grok then Kimi K3", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-deepseek-v4-pro-0813",
      "ask",
    );
    expect(opts.openrouter).toMatchObject({
      reasoning: { enabled: true, effort: "high" },
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

  it("does not force OCR on the Grok route", () => {
    const opts = buildProviderOptions(false, "user-1", "model-grok-4.6", "ask");
    expect(opts.openrouter).toMatchObject({
      reasoning: { enabled: true, effort: "high" },
      models: [KIMI_K3_SLUG],
      user: "user-1",
    });
    expect(opts.openrouter).not.toHaveProperty("plugins");
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

  it("uses high reasoning for free Ask across its fallback chain", () => {
    const opts = buildProviderOptions(false, "user-1", "ask-model-free", "ask");
    expect(opts.openrouter.reasoning).toEqual({
      enabled: true,
      effort: "high",
    });
    expect(opts.openrouter.models).toEqual([GROK_SLUG, KIMI_K3_SLUG]);
  });

  it("keeps free Ask reasoning high over a lower scoped override", () => {
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

  it("keeps free Ask high reasoning for an explicit high override", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "ask-model-free",
      "ask",
      {
        reasoningOverride: { enabled: true, effort: "high" },
      },
    );

    expect(opts.openrouter.reasoning).toEqual({
      enabled: true,
      effort: "high",
    });
  });

  it("keeps Grok fallback reasoning high over a lower scoped override", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-deepseek-v4-pro",
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

  it("allows the Kimi Max experiment to raise a Grok-backed route to max", () => {
    const opts = buildProviderOptions(
      true,
      "user-1",
      "model-opus-4.6",
      "agent",
      {
        reasoningOverride: { enabled: true, effort: "max" },
      },
    );

    expect(opts.openrouter.reasoning).toEqual({
      enabled: true,
      effort: "max",
    });
    expect(opts.openrouter.models).toEqual([GROK_SLUG]);
  });

  it.each([
    { enabled: true, effort: "low" },
    { enabled: true },
    { enabled: false, effort: "max" },
    { enabled: true, effort: "max", exclude: true },
  ])(
    "does not let $p weaken or exclude Grok reasoning",
    (reasoningOverride) => {
      const opts = buildProviderOptions(
        true,
        "user-1",
        "model-opus-4.6",
        "agent",
        { reasoningOverride },
      );

      expect(opts.openrouter.reasoning).toEqual({
        enabled: true,
        effort: "high",
      });
    },
  );

  it("enables high reasoning for the DeepSeek Pro route with a Grok fallback", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-deepseek-v4-pro",
      "ask",
    );
    expect(opts.openrouter.reasoning).toEqual({
      enabled: true,
      effort: "high",
    });
  });

  it("keeps Grok 4.5 Standard vision at medium despite a high override", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-grok-4.5",
      "ask",
      { reasoningOverride: { enabled: true, effort: "high" } },
    );

    expect(opts.openrouter.reasoning).toEqual({
      enabled: true,
      effort: "medium",
    });
  });

  it("does not let a lower override weaken Grok 4.5 Pro vision reasoning", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-grok-4.5-pro",
      "ask",
      { reasoningOverride: { enabled: true, effort: "medium" } },
    );

    expect(opts.openrouter.reasoning).toEqual({
      enabled: true,
      effort: "high",
    });
  });

  it.each([
    "model-grok-4.5-pro",
    "model-grok-4.6-pro",
    "model-glm-5.2",
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
    "model-grok-4.6-pro",
    "model-glm-5.2",
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
      models: [GROK_SLUG],
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
      models: [GROK_SLUG],
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

  it("does not treat an explicit paid Standard selection as Auto", () => {
    expect(
      isAutoModelSelectionForRetry({
        selectedModel: "model-deepseek-v4-pro",
        selectedModelOverride: "hackerai-standard",
      }),
    ).toBe(false);
  });

  it("keeps the Grok 4.6 Pro route retryable", () => {
    expect(
      isAutoModelSelectionForRetry({
        selectedModel: "model-grok-4.6-pro",
        selectedModelOverride: "hackerai-pro",
      }),
    ).toBe(true);
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
      "model-grok-4.6",
    );
  });

  it("retries free Agent DeepSeek Flash with Grok", () => {
    expect(getRetryFallbackModel("agent-model-free", "agent")).toBe(
      "model-grok-4.6",
    );
  });

  it("retries the Grok 4.5 Standard vision route with Kimi K3", () => {
    expect(getRetryFallbackModel("model-grok-4.5", "ask")).toBe(
      "model-kimi-k3",
    );
  });

  it.each(["ask", "agent"] as const)(
    "retries the Max Kimi K3 route with Grok in %s mode",
    (mode) => {
      expect(getRetryFallbackModel("model-opus-4.6", mode)).toBe(
        "model-grok-4.6",
      );
    },
  );

  it("retries HackerAI Pro Grok with GLM 5.2", () => {
    expect(getRetryFallbackModel("model-grok-4.6-pro", "agent")).toBe(
      "model-glm-5.2",
    );
    expect(getRetryFallbackModel("model-grok-4.6-pro", "ask")).toBe(
      "model-glm-5.2",
    );
  });

  it("retries the Grok 4.5 Pro vision route with Kimi K3", () => {
    expect(getRetryFallbackModel("model-grok-4.5-pro", "agent")).toBe(
      "model-kimi-k3",
    );
  });

  it("retries paid DeepSeek Pro with Grok", () => {
    expect(getRetryFallbackModel("model-deepseek-v4-pro", "ask")).toBe(
      "model-grok-4.6",
    );
  });

  it("retries DeepSeek V4 Flash 0731 with DeepSeek V4 Pro 0813", () => {
    expect(getRetryFallbackModel("model-deepseek-v4-flash-0731", "ask")).toBe(
      "model-deepseek-v4-pro-0813",
    );
  });

  it("retries DeepSeek V4 Pro 0813 with Grok", () => {
    expect(getRetryFallbackModel("model-deepseek-v4-pro-0813", "ask")).toBe(
      "model-grok-4.6",
    );
  });

  it("retries Kimi K3 with the active Grok route", () => {
    expect(getRetryFallbackModel("model-kimi-k3", "agent")).toBe(
      "model-grok-4.6",
    );
  });

  it("retries the Grok-backed paid Ask route with Kimi K3", () => {
    expect(getRetryFallbackModel("model-grok-4.6", "ask")).toBe(
      "model-kimi-k3",
    );
  });
});

describe("getContentFilterRetryModel", () => {
  it("uses the normal fallback when the configured primary was served", () => {
    expect(
      getContentFilterRetryModel(
        "agent-model-free",
        "agent",
        DEEPSEEK_FLASH_CANONICAL_SLUG,
      ),
    ).toBe("model-grok-4.6");
  });

  it("skips the normal fallback when OpenRouter already served it", () => {
    expect(
      getContentFilterRetryModel("agent-model-free", "agent", GROK_SLUG),
    ).toBe("model-kimi-k3");
  });

  it("recognizes canonical served-model aliases", () => {
    expect(
      getContentFilterRetryModel(
        "model-grok-4.6",
        "agent",
        "moonshotai/kimi-k3-20260715",
      ),
    ).toBe("model-grok-4.6");
  });
});

describe("resolveServedModelForCostAccounting", () => {
  it("preserves the previous DeepSeek Flash slug for legacy route pricing", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "agent-model-free",
        responseModel: DEEPSEEK_FLASH_PREVIOUS_SLUG,
        mode: "agent",
      }),
    ).toBe(DEEPSEEK_FLASH_PREVIOUS_SLUG);
  });

  it("maps the previous canonical DeepSeek Flash ID to legacy route pricing", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "agent-model-free",
        responseModel: DEEPSEEK_FLASH_PREVIOUS_CANONICAL_SLUG,
        mode: "agent",
      }),
    ).toBe(DEEPSEEK_FLASH_PREVIOUS_SLUG);
  });

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
    ).toBe("model-grok-4.6");
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

  it("maps a direct Grok provider slug back to the Grok 4.6 cost key", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-does-not-exist",
        responseModel: GROK_SLUG,
        mode: "ask",
      }),
    ).toBe("model-grok-4.6");
  });

  it("maps a Grok slug served from Kimi K3 fallback to the active cost key", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-kimi-k3",
        responseModel: GROK_SLUG,
        mode: "agent",
      }),
    ).toBe("model-grok-4.6");
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
        responseModel: GROK_4_5_SLUG,
        mode: "agent",
      }),
    ).toBe("model-grok-4.5-pro");
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-grok-4.5-pro",
        responseModel: "x-ai/grok-4.5-20260708",
        mode: "agent",
      }),
    ).toBe("model-grok-4.5");
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-grok-4.5-pro",
        responseModel: KIMI_K3_SLUG,
        mode: "agent",
      }),
    ).toBe("model-kimi-k3");
  });

  it("maps Standard Agent Grok 4.5 primary and fallback usage to exact cost keys", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-grok-4.5",
        responseModel: GROK_4_5_SLUG,
        mode: "agent",
      }),
    ).toBe("model-grok-4.5");
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-grok-4.5",
        responseModel: "x-ai/grok-4.5-20260708",
        mode: "agent",
      }),
    ).toBe("model-grok-4.5");
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

  it("maps the Max Kimi K3 primary response to the persisted Max cost key", () => {
    expect(
      resolveServedModelForCostAccounting({
        modelName: "model-opus-4.6",
        responseModel: KIMI_K3_SLUG,
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
