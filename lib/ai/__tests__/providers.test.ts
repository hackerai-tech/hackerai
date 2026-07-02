import {
  getModelDisplayName,
  myProvider,
  sanitizeOpenRouterRequestForXai,
  supportsMultimodalToolResults,
} from "@/lib/ai/providers";

describe("provider registry", () => {
  it("keeps paid Ask media, Agent Standard, and stale Kimi compatibility keys pointed at their active slugs", () => {
    expect(
      (myProvider.languageModel("ask-model") as { modelId: string }).modelId,
    ).toBe("x-ai/grok-4.3");
    expect(
      (myProvider.languageModel("agent-model") as { modelId: string }).modelId,
    ).toBe("minimax/minimax-m3");
    expect(
      (myProvider.languageModel("agent-model-free") as { modelId: string })
        .modelId,
    ).toBe("minimax/minimax-m3");
    expect(
      (myProvider.languageModel("model-minimax-m3") as { modelId: string })
        .modelId,
    ).toBe("minimax/minimax-m3");
    expect(
      (myProvider.languageModel("model-grok-4.3") as { modelId: string })
        .modelId,
    ).toBe("x-ai/grok-4.3");
    expect(
      (
        myProvider.languageModel("model-gemini-3-flash") as {
          modelId: string;
        }
      ).modelId,
    ).toBe("x-ai/grok-4.3");
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
    ).toBe("minimax/minimax-m3");
    expect(
      (myProvider.languageModel("fallback-ask-model") as { modelId: string })
        .modelId,
    ).toBe("minimax/minimax-m3");
    expect(
      (myProvider.languageModel("title-generator-model") as { modelId: string })
        .modelId,
    ).toBe("x-ai/grok-4.3");
    expect(getModelDisplayName("model-minimax-m3")).toBe("MiniMax M3");
    expect(getModelDisplayName("model-grok-4.3")).toBe("xAI Grok 4.3");
    expect(getModelDisplayName("model-gemini-3-flash")).toBe("xAI Grok 4.3");
    expect(getModelDisplayName("title-generator-model")).toBe("xAI Grok 4.3");
  });
});

describe("sanitizeOpenRouterRequestForXai", () => {
  it("strips encrypted reasoning details when an OpenRouter fallback can route to xAI", () => {
    const body = {
      model: "minimax/minimax-m3",
      models: ["x-ai/grok-4.3"],
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
      model: "x-ai/grok-4.3",
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
      model: "x-ai/grok-4.3",
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
      model: "minimax/minimax-m3",
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
      model: "x-ai/grok-4.3",
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
  it("allows MiniMax and Kimi registry keys and OpenRouter slugs for image tool result experiments", () => {
    expect(supportsMultimodalToolResults("agent-model")).toBe(true);
    expect(supportsMultimodalToolResults("agent-model-free")).toBe(true);
    expect(supportsMultimodalToolResults("model-minimax-m3")).toBe(true);
    expect(supportsMultimodalToolResults("minimax/minimax-m3")).toBe(true);
    expect(supportsMultimodalToolResults("model-kimi-k2.7-code")).toBe(true);
    expect(
      supportsMultimodalToolResults("moonshotai/kimi-k2.7-code:exacto"),
    ).toBe(true);
  });

  it("allows multimodal fallback keys and slugs used after image tool results", () => {
    expect(supportsMultimodalToolResults("model-grok-4.3")).toBe(true);
    expect(supportsMultimodalToolResults("fallback-grok-4.3")).toBe(true);
    expect(supportsMultimodalToolResults("x-ai/grok-4.3")).toBe(true);
  });

  it("still rejects text-only DeepSeek model keys", () => {
    expect(supportsMultimodalToolResults("model-deepseek-v4-flash")).toBe(
      false,
    );
    expect(supportsMultimodalToolResults("model-deepseek-v4-pro")).toBe(false);
  });
});
