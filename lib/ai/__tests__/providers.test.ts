import {
  getModelDisplayName,
  myProvider,
  sanitizeOpenRouterRequestForXai,
  supportsMultimodalToolResults,
} from "@/lib/ai/providers";

describe("provider registry", () => {
  it("keeps active routes and stale compatibility keys pointed at their provider slugs", () => {
    expect(
      (myProvider.languageModel("ask-model") as { modelId: string }).modelId,
    ).toBe("x-ai/grok-4.5");
    expect(
      (myProvider.languageModel("agent-model") as { modelId: string }).modelId,
    ).toBe("x-ai/grok-4.5");
    expect(
      (myProvider.languageModel("agent-model-free") as { modelId: string })
        .modelId,
    ).toBe("deepseek/deepseek-v4-flash");
    expect(
      (myProvider.languageModel("model-minimax-m3") as { modelId: string })
        .modelId,
    ).toBe("x-ai/grok-4.5");
    expect(
      (myProvider.languageModel("model-grok-4.5") as { modelId: string })
        .modelId,
    ).toBe("x-ai/grok-4.5");
    expect(
      (myProvider.languageModel("model-grok-4.5-pro") as { modelId: string })
        .modelId,
    ).toBe("x-ai/grok-4.5");
    expect(
      (myProvider.languageModel("model-glm-5.2") as { modelId: string })
        .modelId,
    ).toBe("z-ai/glm-5.2");
    expect(
      (
        myProvider.languageModel("model-gemini-3-flash") as {
          modelId: string;
        }
      ).modelId,
    ).toBe("x-ai/grok-4.5");
    expect(
      (
        myProvider.languageModel("model-kimi-k2.6") as {
          modelId: string;
        }
      ).modelId,
    ).toBe("moonshotai/kimi-k2.7-code:exacto");
    expect(
      (myProvider.languageModel("fallback-agent-model") as { modelId: string })
        .modelId,
    ).toBe("x-ai/grok-4.5");
    expect(
      (myProvider.languageModel("fallback-ask-model") as { modelId: string })
        .modelId,
    ).toBe("x-ai/grok-4.5");
    expect(
      (myProvider.languageModel("title-generator-model") as { modelId: string })
        .modelId,
    ).toBe("x-ai/grok-4.5");
    expect(getModelDisplayName("model-minimax-m3")).toBe("xAI Grok 4.5");
    expect(getModelDisplayName("model-grok-4.5")).toBe("xAI Grok 4.5");
    expect(getModelDisplayName("model-grok-4.5-pro")).toBe("xAI Grok 4.5");
    expect(getModelDisplayName("model-glm-5.2")).toBe("Z.ai GLM 5.2");
    expect(getModelDisplayName("model-gemini-3-flash")).toBe("xAI Grok 4.5");
    expect(getModelDisplayName("title-generator-model")).toBe("xAI Grok 4.5");
  });
});

describe("sanitizeOpenRouterRequestForXai", () => {
  it("strips encrypted reasoning details when an OpenRouter fallback can route to xAI", () => {
    const body = {
      model: "moonshotai/kimi-k2.7-code:exacto",
      models: ["x-ai/grok-4.5"],
      messages: [
        {
          role: "assistant",
          content: "Here is the answer.",
          reasoning_details: [
            { type: "text", text: "plain reasoning detail" },
            {
              type: "encrypted",
              encrypted_content: "provider-private-reasoning-blob",
            },
          ],
        },
      ],
    };

    const result = sanitizeOpenRouterRequestForXai(body);

    expect(result.changed).toBe(true);
    expect(result.body).toEqual({
      ...body,
      messages: [
        {
          role: "assistant",
          content: "Here is the answer.",
          reasoning_details: [{ type: "text", text: "plain reasoning detail" }],
        },
      ],
    });
    expect(JSON.stringify(result.body)).not.toContain("encrypted_content");
    expect(JSON.stringify(body)).toContain("encrypted_content");
  });

  it("removes reasoning_details when every detail is encrypted", () => {
    const body = {
      model: "x-ai/grok-4.5",
      messages: [
        {
          role: "assistant",
          content: "Visible text stays.",
          reasoning_details: [
            { type: "encrypted", encrypted_content: "x-provider-blob" },
          ],
        },
      ],
    };

    const result = sanitizeOpenRouterRequestForXai(body);

    expect(result.changed).toBe(true);
    expect(result.body).toEqual({
      model: "x-ai/grok-4.5",
      messages: [
        {
          role: "assistant",
          content: "Visible text stays.",
        },
      ],
    });
  });

  it("leaves non-xAI routes unchanged", () => {
    const body = {
      model: "moonshotai/kimi-k2.7-code:exacto",
      messages: [
        {
          role: "assistant",
          content: "Here is the answer.",
          reasoning_details: [
            { type: "encrypted", encrypted_content: "provider-blob" },
          ],
        },
      ],
    };

    const result = sanitizeOpenRouterRequestForXai(body);

    expect(result.changed).toBe(false);
    expect(result.body).toBe(body);
  });

  it("preserves encrypted_content outside provider reasoning metadata", () => {
    const body = {
      model: "x-ai/grok-4.5",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Please inspect this payload.",
            },
            {
              type: "input_json",
              encrypted_content: "user-owned-data",
            },
          ],
        },
        {
          role: "assistant",
          content: "Visible text stays.",
          tool_calls: [
            {
              id: "call_1",
              function: {
                name: "decrypt",
                arguments: JSON.stringify({
                  encrypted_content: "tool-owned-data",
                }),
              },
            },
          ],
        },
      ],
    };

    const result = sanitizeOpenRouterRequestForXai(body);

    expect(result.changed).toBe(false);
    expect(result.body).toBe(body);
    expect(JSON.stringify(result.body)).toContain("user-owned-data");
    expect(JSON.stringify(result.body)).toContain("tool-owned-data");
  });
});

describe("supportsMultimodalToolResults", () => {
  it("allows Grok aliases and Kimi routes for image tool result experiments", () => {
    expect(supportsMultimodalToolResults("agent-model")).toBe(true);
    expect(supportsMultimodalToolResults("ask-model")).toBe(true);
    expect(supportsMultimodalToolResults("model-minimax-m3")).toBe(true);
    expect(supportsMultimodalToolResults("fallback-agent-model")).toBe(true);
    expect(supportsMultimodalToolResults("fallback-ask-model")).toBe(true);
    expect(supportsMultimodalToolResults("model-kimi-k2.7-code")).toBe(true);
    expect(
      supportsMultimodalToolResults("moonshotai/kimi-k2.7-code:exacto"),
    ).toBe(true);
  });

  it("allows multimodal fallback keys and slugs used after image tool results", () => {
    expect(supportsMultimodalToolResults("model-grok-4.5")).toBe(true);
    expect(supportsMultimodalToolResults("model-grok-4.5-pro")).toBe(true);
    expect(supportsMultimodalToolResults("model-gemini-3-flash")).toBe(true);
    expect(supportsMultimodalToolResults("fallback-grok-4.5")).toBe(true);
    expect(supportsMultimodalToolResults("x-ai/grok-4.5")).toBe(true);
  });

  it("still rejects text-only DeepSeek model keys", () => {
    expect(supportsMultimodalToolResults("agent-model-free")).toBe(false);
    expect(supportsMultimodalToolResults("model-deepseek-v4-flash")).toBe(
      false,
    );
    expect(supportsMultimodalToolResults("model-deepseek-v4-pro")).toBe(false);
  });
});
