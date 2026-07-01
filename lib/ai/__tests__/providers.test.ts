import {
  getModelDisplayName,
  isDeepSeekModel,
  myProvider,
  supportsMultimodalToolResults,
} from "@/lib/ai/providers";

describe("provider registry", () => {
  it("routes every registry key to the configured DeepSeek model", () => {
    const keys = [
      "ask-model",
      "ask-model-free",
      "agent-model",
      "agent-model-free",
      "model-sonnet-4.6",
      "model-grok-4.3",
      "model-gemini-3-flash",
      "model-deepseek-v4-flash",
      "model-deepseek-v4-pro",
      "model-opus-4.6",
      "model-minimax-m3",
      "model-kimi-k2.7-code",
      "model-kimi-k2.6",
      "fallback-agent-model",
      "fallback-ask-model",
      "fallback-gemini-3.5-flash",
      "fallback-grok-4.3",
      "title-generator-model",
    ];

    for (const key of keys) {
      expect(
        (myProvider.languageModel(key) as { modelId: string }).modelId,
      ).toBe("deepseek-v4-flash");
      expect(getModelDisplayName(key)).toBe("DeepSeek");
    }
  });
});

describe("isDeepSeekModel", () => {
  it("is always true since DeepSeek is the only provider", () => {
    expect(isDeepSeekModel("ask-model")).toBe(true);
    expect(isDeepSeekModel("anything")).toBe(true);
  });
});

describe("supportsMultimodalToolResults", () => {
  it("is always false — DeepSeek's chat completions API does not return multimodal tool results", () => {
    expect(supportsMultimodalToolResults("ask-model")).toBe(false);
    expect(supportsMultimodalToolResults("agent-model")).toBe(false);
    expect(supportsMultimodalToolResults(undefined)).toBe(false);
  });
});
