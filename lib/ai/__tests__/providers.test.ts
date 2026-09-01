import {
  AUXILIARY_VISION_SLUG,
  DEEPSEEK_V4_FLASH_VISION_SLUG,
  GLM_5_3_FLASH_SLUG,
  createOpenRouterPatchFetch,
  enrichOpenRouterStreamError,
  getModelCutoffDate,
  getModelDisplayName,
  isAnthropicModel,
  isDeepSeekModel,
  isKimiModel,
  createTrackedProvider,
  myProvider,
  MALFORMED_PDF_USER_RESPONSE,
  makeOpenRouterToolChoiceCompatibleWithXaiReasoning,
  normalizeOpenRouterRequestForKimi,
  OPENROUTER_REQUEST_MAX_BYTES,
  PDF_PARSER_ENGINE_HEADER,
  PDF_PARSER_RECOVERY_HEADER,
  sanitizeOpenRouterEncryptedReasoning,
  supportsMultimodalToolResults,
} from "@/lib/ai/providers";

const edgeFetchPrimitives =
  require("next/dist/compiled/@edge-runtime/primitives/fetch") as {
    Headers: typeof Headers;
    Response: typeof Response;
  };
const originalHeaders = globalThis.Headers;
const originalResponse = globalThis.Response;

beforeAll(() => {
  globalThis.Headers = edgeFetchPrimitives.Headers;
  globalThis.Response = edgeFetchPrimitives.Response;
});

afterAll(() => {
  globalThis.Headers = originalHeaders;
  globalThis.Response = originalResponse;
});

const PDF_PARSER_RATE_LIMIT_ERROR =
  "The document parsing engine is currently rate limited. Please retry shortly.";
const PDF_PARSER_INVALID_DOCUMENT_ERROR =
  "The file could not be read as a valid document. It may be corrupt, truncated, or not actually a PDF.";

const createPdfParserRequest = (includeSandboxPath = true) => ({
  model: "deepseek/deepseek-v4-flash-0731",
  plugins: [{ id: "file-parser", pdf: { engine: "mistral-ocr" } }],
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: includeSandboxPath
            ? '<attachment filename="report.pdf" local_path="/home/user/upload/report.pdf" />\nReview this PDF.'
            : "Review this PDF.",
        },
        {
          type: "file",
          file: {
            filename: "report.pdf",
            file_data: "data:application/pdf;base64,JVBERi0=",
          },
        },
        {
          type: "file",
          file: {
            filename: "notes.txt",
            file_data: "data:text/plain;base64,bm90ZXM=",
          },
        },
      ],
    },
  ],
});

const parserErrorResponse = (message: string) =>
  new Response(
    JSON.stringify({ error: { message: `Failed to parse : ${message}` } }),
    {
      status: 400,
      headers: { "content-type": "application/json" },
    },
  );

describe("enrichOpenRouterStreamError", () => {
  it("attaches response IDs to body errors that happen after headers", () => {
    expect(
      enrichOpenRouterStreamError(new Error("Network connection lost."), {
        "x-generation-id": "gen-header-1",
        "x-request-id": "req-header-1",
      }),
    ).toMatchObject({
      message: "Network connection lost.",
      responseHeaders: expect.objectContaining({
        "x-generation-id": "gen-header-1",
        "x-request-id": "req-header-1",
      }),
    });
  });
});

describe("provider registry", () => {
  it("keeps active routes pointed at their provider slugs", () => {
    expect(
      (myProvider.languageModel("ask-model") as { modelId: string }).modelId,
    ).toBe("x-ai/grok-4.6");
    expect(
      (myProvider.languageModel("agent-model") as { modelId: string }).modelId,
    ).toBe("x-ai/grok-4.6");
    expect(
      (myProvider.languageModel("ask-model-free") as { modelId: string })
        .modelId,
    ).toBe("z-ai/glm-5.3-flash");
    expect(
      (myProvider.languageModel("agent-model-free") as { modelId: string })
        .modelId,
    ).toBe("z-ai/glm-5.3-flash");
    expect(
      (
        myProvider.languageModel("auxiliary-vision-model") as {
          modelId: string;
        }
      ).modelId,
    ).toBe("minimax/minimax-m3");
    expect(AUXILIARY_VISION_SLUG).toBe("minimax/minimax-m3");
    expect(GLM_5_3_FLASH_SLUG).toBe("z-ai/glm-5.3-flash");
    expect(DEEPSEEK_V4_FLASH_VISION_SLUG).toBe(
      "deepseek/deepseek-v4-flash-vision-exp",
    );
    expect(
      (myProvider.languageModel("model-glm-5.3-flash") as { modelId: string })
        .modelId,
    ).toBe(GLM_5_3_FLASH_SLUG);
    expect(
      (
        myProvider.languageModel("model-glm-5.3-flash-agent") as {
          modelId: string;
        }
      ).modelId,
    ).toBe(GLM_5_3_FLASH_SLUG);
    expect(
      (
        myProvider.languageModel("model-deepseek-v4-flash-vision") as {
          modelId: string;
        }
      ).modelId,
    ).toBe(DEEPSEEK_V4_FLASH_VISION_SLUG);
    expect(getModelCutoffDate("auxiliary-vision-model")).toBe("July 2026");
    expect(
      (myProvider.languageModel("model-grok-4.6") as { modelId: string })
        .modelId,
    ).toBe("x-ai/grok-4.6");
    expect(
      (myProvider.languageModel("model-grok-4.5") as { modelId: string })
        .modelId,
    ).toBe("x-ai/grok-4.5");
    expect(
      (myProvider.languageModel("model-grok-4.5-pro") as { modelId: string })
        .modelId,
    ).toBe("x-ai/grok-4.5");
    expect(
      (myProvider.languageModel("model-grok-4.6-pro") as { modelId: string })
        .modelId,
    ).toBe("x-ai/grok-4.6");
    expect(
      (
        myProvider.languageModel("model-deepseek-v4-flash-0731") as {
          modelId: string;
        }
      ).modelId,
    ).toBe("deepseek/deepseek-v4-flash-0731");
    expect(
      (
        myProvider.languageModel("model-deepseek-v4-pro-0813") as {
          modelId: string;
        }
      ).modelId,
    ).toBe("deepseek/deepseek-v4-pro-0813");
    expect(
      (myProvider.languageModel("model-glm-5.2") as { modelId: string })
        .modelId,
    ).toBe("z-ai/glm-5.2");
    expect(
      (myProvider.languageModel("model-glm-5.3") as { modelId: string })
        .modelId,
    ).toBe("z-ai/glm-5.3");
    expect(
      (myProvider.languageModel("model-kimi-k3") as { modelId: string })
        .modelId,
    ).toBe("moonshotai/kimi-k3");
    expect(
      (myProvider.languageModel("model-opus-4.6") as { modelId: string })
        .modelId,
    ).toBe("moonshotai/kimi-k3");
    expect(
      (myProvider.languageModel("fallback-agent-model") as { modelId: string })
        .modelId,
    ).toBe("x-ai/grok-4.6");
    expect(
      (myProvider.languageModel("fallback-ask-model") as { modelId: string })
        .modelId,
    ).toBe("x-ai/grok-4.6");
    expect(
      (myProvider.languageModel("title-generator-model") as { modelId: string })
        .modelId,
    ).toBe("deepseek/deepseek-v4-flash");
    expect(
      (
        myProvider.languageModel("agent-auto-review-model") as {
          modelId: string;
        }
      ).modelId,
    ).toBe("deepseek/deepseek-v4-flash-0731");
    expect(getModelCutoffDate("ask-model-free")).toBeUndefined();
    expect(getModelCutoffDate("agent-model-free")).toBeUndefined();
    expect(getModelDisplayName("model-grok-4.6")).toBe("xAI Grok 4.6");
    expect(getModelDisplayName("model-grok-4.5")).toBe("xAI Grok 4.5");
    expect(getModelDisplayName("model-grok-4.5-pro")).toBe("xAI Grok 4.5");
    expect(getModelCutoffDate("model-grok-4.5")).toBeUndefined();
    expect(getModelCutoffDate("model-grok-4.5-pro")).toBeUndefined();
    expect(getModelDisplayName("model-grok-4.6-pro")).toBe("xAI Grok 4.6");
    expect(getModelCutoffDate("model-grok-4.6-pro")).toBe("August 2026");
    expect(getModelDisplayName("model-deepseek-v4-flash-0731")).toBe(
      "DeepSeek V4 Flash 0731",
    );
    expect(getModelCutoffDate("model-deepseek-v4-flash-0731")).toBe(
      "July 2026",
    );
    expect(getModelDisplayName("model-deepseek-v4-pro-0813")).toBe(
      "DeepSeek V4 Pro 0813",
    );
    expect(getModelCutoffDate("model-deepseek-v4-pro-0813")).toBe(
      "August 2026",
    );
    expect(getModelDisplayName("model-glm-5.2")).toBe("Z.ai GLM 5.2");
    expect(getModelDisplayName("model-glm-5.3")).toBe("Z.ai GLM 5.3");
    expect(getModelCutoffDate("model-glm-5.3")).toBeUndefined();
    expect(getModelDisplayName("model-kimi-k3")).toBe("Moonshot Kimi K3");
    expect(getModelCutoffDate("model-opus-4.6")).toBe("July 2026");
    expect(getModelDisplayName("model-opus-4.6")).toBe("Moonshot Kimi K3");
    expect(getModelDisplayName("title-generator-model")).toBe(
      "DeepSeek V4 Flash",
    );
    expect(getModelDisplayName("agent-auto-review-model")).toBe(
      "DeepSeek V4 Flash 0731",
    );
    expect(getModelCutoffDate("agent-auto-review-model")).toBe("July 2026");
  });

  it("applies Kimi rather than Anthropic provider behavior to HackerAI Max", () => {
    expect(isKimiModel("model-opus-4.6")).toBe(true);
    expect(isAnthropicModel("model-opus-4.6")).toBe(false);
    expect(isAnthropicModel("anthropic/claude-opus-4.6")).toBe(true);
  });

  it("classifies the active DeepSeek tier routes as DeepSeek", () => {
    expect(isDeepSeekModel("ask-model-free")).toBe(false);
    expect(isDeepSeekModel("agent-model-free")).toBe(false);
    expect(isDeepSeekModel("model-deepseek-v4-flash-0731")).toBe(true);
    expect(isDeepSeekModel("model-deepseek-v4-pro")).toBe(true);
    expect(isDeepSeekModel("model-deepseek-v4-pro-0813")).toBe(true);
    expect(isDeepSeekModel("agent-auto-review-model")).toBe(true);
  });

  it("keeps both tracked free routes on GLM 5.3 Flash", () => {
    const provider = createTrackedProvider();
    expect(
      (provider.languageModel("ask-model-free") as { modelId: string }).modelId,
    ).toBe("z-ai/glm-5.3-flash");
    expect(
      (provider.languageModel("agent-model-free") as { modelId: string })
        .modelId,
    ).toBe("z-ai/glm-5.3-flash");
  });

  it.each([
    "model-sonnet-4.6",
    "model-gemini-3-flash",
    "model-minimax-m3",
    "model-kimi-k2.6",
    "model-kimi-k2.7-code",
    "model-deepseek-v4-flash",
    "fallback-grok-4.5",
  ])("does not register retired route %s", (modelName) => {
    expect(() => myProvider.languageModel(modelName)).toThrow();
  });
});

describe("sanitizeOpenRouterEncryptedReasoning", () => {
  it("strips encrypted reasoning details when an OpenRouter fallback can route to xAI", () => {
    const body = {
      model: "moonshotai/kimi-k3",
      models: ["x-ai/grok-4.6"],
      messages: [
        {
          role: "assistant",
          content: "Here is the answer.",
          reasoning_details: [
            { type: "text", text: "plain reasoning detail" },
            {
              type: "reasoning.encrypted",
              data: "provider-private-reasoning-blob",
            },
            { type: "encrypted", encrypted_content: "legacy-provider-blob" },
          ],
        },
      ],
    };

    const result = sanitizeOpenRouterEncryptedReasoning(body);

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
    expect(JSON.stringify(result.body)).not.toContain(
      "provider-private-reasoning-blob",
    );
    expect(JSON.stringify(result.body)).not.toContain("legacy-provider-blob");
    expect(JSON.stringify(body)).toContain("provider-private-reasoning-blob");
    expect(JSON.stringify(body)).toContain("legacy-provider-blob");
  });

  it("removes reasoning_details when every detail is encrypted", () => {
    const body = {
      model: "x-ai/grok-4.5",
      messages: [
        {
          role: "assistant",
          content: "Visible text stays.",
          reasoning_details: [
            { type: "reasoning.encrypted", data: "x-provider-blob" },
          ],
        },
      ],
    };

    const result = sanitizeOpenRouterEncryptedReasoning(body);

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

  it("strips encrypted reasoning from non-xAI routes", () => {
    const body = {
      model: "deepseek/deepseek-v4-flash-0731",
      models: ["z-ai/glm-5.3", "moonshotai/kimi-k3"],
      messages: [
        {
          role: "assistant",
          content: "Here is the answer.",
          reasoning_details: [
            { type: "reasoning.text", text: "Visible reasoning stays." },
            {
              type: "reasoning.encrypted",
              data: "xai-provider-private-blob",
              format: "xai-responses-v1",
            },
          ],
        },
      ],
    };

    const result = sanitizeOpenRouterEncryptedReasoning(body);

    expect(result.changed).toBe(true);
    expect(result.body).toEqual({
      ...body,
      messages: [
        {
          role: "assistant",
          content: "Here is the answer.",
          reasoning_details: [
            { type: "reasoning.text", text: "Visible reasoning stays." },
          ],
        },
      ],
    });
  });

  it("strips encrypted reasoning from Responses-style input", () => {
    const body = {
      model: "deepseek/deepseek-v4-flash-0731",
      input: [
        {
          role: "assistant",
          content: "Visible answer stays.",
          provider_options: {
            openrouter: {
              reasoning_details: [
                {
                  type: "reasoning.encrypted",
                  data: "provider-private-blob",
                },
              ],
            },
          },
        },
      ],
    };

    const result = sanitizeOpenRouterEncryptedReasoning(body);

    expect(result.changed).toBe(true);
    expect(result.body).toEqual({
      ...body,
      input: [
        {
          role: "assistant",
          content: "Visible answer stays.",
          provider_options: { openrouter: {} },
        },
      ],
    });
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
            {
              type: "reasoning.encrypted",
              data: "user-owned-reasoning-shaped-data",
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

    const result = sanitizeOpenRouterEncryptedReasoning(body);

    expect(result.changed).toBe(false);
    expect(result.body).toBe(body);
    expect(JSON.stringify(result.body)).toContain("user-owned-data");
    expect(JSON.stringify(result.body)).toContain(
      "user-owned-reasoning-shaped-data",
    );
    expect(JSON.stringify(result.body)).toContain("tool-owned-data");
  });
});

describe("normalizeOpenRouterRequestForKimi", () => {
  it("repairs missing chat tool-call IDs and removes unmatchable results", () => {
    const body = {
      model: "moonshotai/kimi-k3",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "call_1", function: { name: "first", arguments: "{}" } },
            { id: "", function: { name: "second", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "first result" },
        { role: "tool", content: "second result" },
        { role: "tool", tool_call_id: "orphan", content: "orphan result" },
      ],
    };

    const result = normalizeOpenRouterRequestForKimi(body);

    expect(result.changed).toBe(true);
    expect(result.body).toEqual({
      ...body,
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "call_1", function: { name: "first", arguments: "{}" } },
            {
              id: "hackerai_recovered_0_1",
              function: { name: "second", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "first result" },
        {
          role: "tool",
          tool_call_id: "hackerai_recovered_0_1",
          content: "second result",
        },
      ],
    });
  });

  it("repairs Responses API function-call output IDs", () => {
    const body = {
      model: "moonshotai/kimi-k3",
      input: [
        { type: "function_call", call_id: "", name: "lookup" },
        { type: "function_call_output", output: "done" },
      ],
    };

    expect(normalizeOpenRouterRequestForKimi(body)).toEqual({
      changed: true,
      body: {
        ...body,
        input: [
          {
            type: "function_call",
            call_id: "hackerai_recovered_0",
            name: "lookup",
          },
          {
            type: "function_call_output",
            call_id: "hackerai_recovered_0",
            output: "done",
          },
        ],
      },
    });
  });

  it("leaves non-Kimi requests untouched", () => {
    const body = {
      model: "deepseek/deepseek-v4-flash-0731",
      messages: [{ role: "tool", content: "missing id" }],
    };

    expect(normalizeOpenRouterRequestForKimi(body)).toEqual({
      body,
      changed: false,
    });
  });
});

describe("makeOpenRouterToolChoiceCompatibleWithXaiReasoning", () => {
  it("preserves forced tool choice and reasoning on a non-xAI fallback", () => {
    const body = {
      model: "x-ai/grok-4.6",
      models: ["x-ai/grok-4.6-20260810", "moonshotai/kimi-k3"],
      reasoning: { enabled: true, effort: "high" },
      tool_choice: { type: "function", function: { name: "wait_for_agents" } },
    };

    expect(makeOpenRouterToolChoiceCompatibleWithXaiReasoning(body)).toEqual({
      changed: true,
      body: {
        model: "moonshotai/kimi-k3",
        reasoning: { enabled: true, effort: "high" },
        tool_choice: body.tool_choice,
      },
    });
  });

  it("preserves the remaining non-xAI fallback order after promotion", () => {
    const body = {
      model: "x-ai/grok-4.6",
      models: ["z-ai/glm-5.3", "moonshotai/kimi-k3"],
      reasoning: { enabled: true, effort: "high" },
      tool_choice: "required",
    };

    expect(makeOpenRouterToolChoiceCompatibleWithXaiReasoning(body)).toEqual({
      changed: true,
      body: {
        model: "z-ai/glm-5.3",
        models: ["moonshotai/kimi-k3"],
        reasoning: { enabled: true, effort: "high" },
        tool_choice: "required",
      },
    });
  });

  it("leaves automatic tool choice unchanged", () => {
    const body = {
      model: "x-ai/grok-4.6",
      reasoning: { enabled: true, effort: "high" },
      tool_choice: "auto",
    };

    expect(makeOpenRouterToolChoiceCompatibleWithXaiReasoning(body)).toEqual({
      body,
      changed: false,
    });
  });

  it("uses automatic tool choice when an xAI-only route has no fallback", () => {
    const body = {
      model: "x-ai/grok-4.6",
      reasoning: { enabled: true, effort: "high" },
      tool_choice: "required",
    };

    expect(makeOpenRouterToolChoiceCompatibleWithXaiReasoning(body)).toEqual({
      changed: true,
      body: { ...body, tool_choice: "auto" },
    });
  });

  it("leaves disabled tool choice unchanged", () => {
    const body = {
      model: "x-ai/grok-4.6",
      reasoning: { enabled: true, effort: "high" },
      tool_choice: "none",
    };

    expect(makeOpenRouterToolChoiceCompatibleWithXaiReasoning(body)).toEqual({
      body,
      changed: false,
    });
  });

  it("keeps the existing disabled-reasoning compatibility for older xAI routes", () => {
    const body = {
      model: "x-ai/grok-4.5",
      models: ["moonshotai/kimi-k3"],
      reasoning: { enabled: true, effort: "high" },
      tool_choice: "required",
    };

    expect(makeOpenRouterToolChoiceCompatibleWithXaiReasoning(body)).toEqual({
      changed: true,
      body: {
        ...body,
        reasoning: { enabled: false, effort: "high" },
      },
    });
  });
});

describe("OpenRouter request normalization", () => {
  it("allows a request exactly at the complete serialized byte limit", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const patchedFetch = createOpenRouterPatchFetch(
      fetchMock as unknown as typeof fetch,
    );
    const body = " ".repeat(OPENROUTER_REQUEST_MAX_BYTES);

    await patchedFetch("https://openrouter.test/chat", {
      method: "POST",
      body,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].body).toBe(body);
  });

  it("enforces the aggregate request limit and falls back to sandbox-backed files", async () => {
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const patchedFetch = createOpenRouterPatchFetch(
      fetchMock as unknown as typeof fetch,
    );
    const perFileData = "a".repeat(OPENROUTER_REQUEST_MAX_BYTES / 2);

    try {
      await patchedFetch("https://openrouter.test/chat", {
        method: "POST",
        headers: { "content-length": "stale" },
        body: JSON.stringify({
          model: "deepseek/deepseek-v4-flash-0731",
          user: "user_test_request_size_guard",
          plugins: [{ id: "file-parser" }],
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: '<attachment filename="first.bin" local_path="/home/user/upload/first.bin" /><attachment filename="second.bin" local_path="/home/user/upload/second.bin" />',
                },
                {
                  type: "file",
                  file: { filename: "first.bin", file_data: perFileData },
                },
                {
                  type: "file",
                  file: { filename: "second.bin", file_data: perFileData },
                },
              ],
            },
          ],
        }),
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const sentInit = fetchMock.mock.calls[0][1];
      const sentBody = String(sentInit.body);
      expect(new TextEncoder().encode(sentBody).byteLength).toBeLessThanOrEqual(
        OPENROUTER_REQUEST_MAX_BYTES,
      );
      expect(new Headers(sentInit.headers).has("content-length")).toBe(false);
      expect(sentBody).not.toContain(perFileData);
      expect(sentBody).toContain("inspect the files with sandbox tools");
      expect(JSON.parse(sentBody).plugins).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"action":"sandbox_file_fallback"'),
      );
      const logEvent = JSON.parse(String(warnSpy.mock.calls[0][0]));
      expect(logEvent).toMatchObject({
        reason: "request_limit_exceeded",
        user_id: "user_test_request_size_guard",
      });
      const serializedLogEvent = JSON.stringify(logEvent);
      expect(serializedLogEvent).not.toContain("first.bin");
      expect(serializedLogEvent).not.toContain(perFileData.slice(0, 1024));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("removes oversized inline tool media while preserving user media and text tool output", async () => {
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const patchedFetch = createOpenRouterPatchFetch(
      fetchMock as unknown as typeof fetch,
    );
    const inlineToolImage = `data:image/jpeg;base64,${"a".repeat(
      OPENROUTER_REQUEST_MAX_BYTES - 512 * 1024,
    )}`;
    const logOutput = "log line\n".repeat(80_000);

    try {
      await patchedFetch("https://openrouter.test/chat", {
        method: "POST",
        headers: { "content-length": "stale" },
        body: JSON.stringify({
          model: "deepseek/deepseek-v4-flash-0731",
          user: "user_test_tool_media_guard",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Analyze this image and log." },
                {
                  type: "image_url",
                  image_url: { url: "https://files.test/photo.jpg" },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "view_1",
              content: [
                { type: "text", text: "Viewing image file: photo.jpg" },
                {
                  type: "image_url",
                  image_url: { url: inlineToolImage },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "read_1",
              content: logOutput,
            },
          ],
        }),
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const sentInit = fetchMock.mock.calls[0][1];
      const sentBody = String(sentInit.body);
      expect(new TextEncoder().encode(sentBody).byteLength).toBeLessThanOrEqual(
        OPENROUTER_REQUEST_MAX_BYTES,
      );
      expect(new Headers(sentInit.headers).has("content-length")).toBe(false);
      expect(sentBody).not.toContain(inlineToolImage);
      expect(sentBody).toContain("https://files.test/photo.jpg");
      expect(JSON.parse(sentBody).messages[2].content).toBe(logOutput);
      expect(sentBody).toContain(
        "Inline media from this tool result was omitted",
      );

      const guardLog = JSON.parse(String(warnSpy.mock.calls[0][0]));
      expect(guardLog).toMatchObject({
        event: "openrouter_request_size_guard",
        action: "tool_media_fallback",
        user_id: "user_test_tool_media_guard",
        inline_tool_media_part_count: 1,
        removed_tool_media_part_count: 1,
        removed_provider_file_part_count: 0,
      });
      expect(guardLog.request_id).toEqual(expect.any(String));
      expect(guardLog.inline_tool_media_bytes).toBeGreaterThan(
        OPENROUTER_REQUEST_MAX_BYTES - 512 * 1024,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rejects an oversized request locally when no safe fallback can fit", async () => {
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const fetchMock = jest.fn();
    const patchedFetch = createOpenRouterPatchFetch(
      fetchMock as unknown as typeof fetch,
    );

    try {
      const response = await patchedFetch("https://openrouter.test/chat", {
        method: "POST",
        body: JSON.stringify({
          model: "deepseek/deepseek-v4-flash-0731",
          messages: [
            {
              role: "user",
              content: "x".repeat(OPENROUTER_REQUEST_MAX_BYTES),
            },
          ],
        }),
      });

      expect(response.status).toBe(413);
      expect(
        response.headers.get("x-hackerai-openrouter-request-size-guard"),
      ).toBe("rejected");
      expect(
        response.headers.get("x-hackerai-openrouter-request-bytes-before"),
      ).toMatch(/^\d+$/);
      expect(
        response.headers.get("x-hackerai-openrouter-request-bytes-after"),
      ).toMatch(/^\d+$/);
      expect(
        response.headers.get("x-hackerai-openrouter-request-limit-bytes"),
      ).toBe(String(OPENROUTER_REQUEST_MAX_BYTES));
      expect(response.headers.get("x-hackerai-request-id")).toEqual(
        expect.any(String),
      );
      expect(await response.json()).toMatchObject({
        error: { code: "request_too_large" },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"action":"rejected"'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rejects duplicate filenames instead of removing an ambiguous file part", async () => {
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const fetchMock = jest.fn();
    const patchedFetch = createOpenRouterPatchFetch(
      fetchMock as unknown as typeof fetch,
    );
    const perFileData = "a".repeat(OPENROUTER_REQUEST_MAX_BYTES / 2);

    try {
      const response = await patchedFetch("https://openrouter.test/chat", {
        method: "POST",
        body: JSON.stringify({
          model: "deepseek/deepseek-v4-flash-0731",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: '<attachment filename="report.pdf" local_path="/home/user/upload/report.pdf" />',
                },
                {
                  type: "file",
                  file: { filename: "report.pdf", file_data: perFileData },
                },
                {
                  type: "file",
                  file: { filename: "report.pdf", file_data: perFileData },
                },
              ],
            },
          ],
        }),
      });

      expect(response.status).toBe(413);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"action":"rejected"'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("measures after encrypted reasoning normalization reduces the body", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const patchedFetch = createOpenRouterPatchFetch(
      fetchMock as unknown as typeof fetch,
    );

    await patchedFetch("https://openrouter.test/chat", {
      method: "POST",
      body: JSON.stringify({
        model: "x-ai/grok-4.5",
        messages: [
          {
            role: "assistant",
            content: "Visible reasoning remains available.",
            reasoning_details: [
              {
                type: "reasoning.encrypted",
                data: "x".repeat(OPENROUTER_REQUEST_MAX_BYTES),
              },
            ],
          },
        ],
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentBody = String(fetchMock.mock.calls[0][1].body);
    expect(new TextEncoder().encode(sentBody).byteLength).toBeLessThan(
      OPENROUTER_REQUEST_MAX_BYTES,
    );
    expect(sentBody).not.toContain('"reasoning_details"');
  });

  it("removes endpoint-pinned reasoning before a cross-model Agent step", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const patchedFetch = createOpenRouterPatchFetch(
      fetchMock as unknown as typeof fetch,
    );

    await patchedFetch("https://openrouter.test/chat", {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek/deepseek-v4-flash-0731",
        models: ["z-ai/glm-5.3", "moonshotai/kimi-k3"],
        messages: [
          {
            role: "assistant",
            content: "A prior Agent step completed.",
            reasoning_details: [
              {
                type: "reasoning.encrypted",
                data: "xai-endpoint-pinned-blob",
                format: "xai-responses-v1",
              },
            ],
          },
          { role: "user", content: "Summarize the next step." },
        ],
      }),
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.model).toBe("deepseek/deepseek-v4-flash-0731");
    expect(requestBody.models).toEqual(["z-ai/glm-5.3", "moonshotai/kimi-k3"]);
    expect(requestBody.messages).toEqual([
      { role: "assistant", content: "A prior Agent step completed." },
      { role: "user", content: "Summarize the next step." },
    ]);
    expect(JSON.stringify(requestBody)).not.toContain(
      "xai-endpoint-pinned-blob",
    );
  });

  it("routes a forced Grok tool step through Kimi without disabling reasoning", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const patchedFetch = createOpenRouterPatchFetch(
      fetchMock as unknown as typeof fetch,
    );

    const toolChoice = {
      type: "function",
      function: { name: "wait_for_agents" },
    };
    await patchedFetch("https://openrouter.test/chat", {
      method: "POST",
      body: JSON.stringify({
        model: "x-ai/grok-4.6",
        models: ["moonshotai/kimi-k3"],
        reasoning: { enabled: true, effort: "high" },
        tool_choice: toolChoice,
        messages: [{ role: "user", content: "Wait for delegated results." }],
      }),
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      model: "moonshotai/kimi-k3",
      reasoning: { enabled: true, effort: "high" },
      tool_choice: toolChoice,
    });
    expect(requestBody.models).toBeUndefined();
  });

  it("applies Kimi transcript repair and xAI tool-choice compatibility together", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const patchedFetch = createOpenRouterPatchFetch(
      fetchMock as unknown as typeof fetch,
    );

    await patchedFetch("https://openrouter.test/chat", {
      method: "POST",
      body: JSON.stringify({
        model: "moonshotai/kimi-k3",
        models: ["x-ai/grok-4.6"],
        reasoning: { enabled: true, effort: "high" },
        tool_choice: {
          type: "function",
          function: { name: "wait_for_agents" },
        },
        messages: [
          {
            role: "assistant",
            tool_calls: [{ id: "", function: { name: "wait_for_agents" } }],
          },
          { role: "tool", content: "agents complete" },
        ],
      }),
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.reasoning).toEqual({ enabled: false, effort: "high" });
    expect(requestBody.models).toEqual(["x-ai/grok-4.6"]);
    expect(requestBody.messages).toEqual([
      {
        role: "assistant",
        reasoning: ".",
        tool_calls: [
          {
            id: "hackerai_recovered_0_0",
            function: { name: "wait_for_agents" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "hackerai_recovered_0_0",
        content: "agents complete",
      },
    ]);
  });
});

describe("OpenRouter PDF parser recovery", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("falls back from Mistral OCR to Cloudflare AI", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(parserErrorResponse(PDF_PARSER_RATE_LIMIT_ERROR))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const patchedFetch = createOpenRouterPatchFetch(
      fetchMock as unknown as typeof fetch,
    );

    const response = await patchedFetch("https://openrouter.test/chat", {
      method: "POST",
      body: JSON.stringify(createPdfParserRequest()),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const cloudflareRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(cloudflareRequest.plugins).toEqual([
      { id: "file-parser", pdf: { engine: "cloudflare-ai" } },
    ]);
    expect(response.headers.get(PDF_PARSER_ENGINE_HEADER)).toBe(
      "cloudflare-ai",
    );
  });

  it.each([PDF_PARSER_RATE_LIMIT_ERROR, PDF_PARSER_INVALID_DOCUMENT_ERROR])(
    "uses one sandbox-only recovery after both parsers return %s",
    async (parserError) => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(parserErrorResponse(parserError))
        .mockResolvedValueOnce(parserErrorResponse(parserError))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));
      const patchedFetch = createOpenRouterPatchFetch(
        fetchMock as unknown as typeof fetch,
      );

      const response = await patchedFetch("https://openrouter.test/chat", {
        method: "POST",
        body: JSON.stringify(createPdfParserRequest()),
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const sandboxRequest = JSON.parse(fetchMock.mock.calls[2][1].body);
      expect(sandboxRequest.plugins).toEqual([]);
      const remainingFiles = sandboxRequest.messages.flatMap(
        (message: { content?: Array<{ type?: string; file?: unknown }> }) =>
          (message.content ?? []).filter((part) => part.type === "file"),
      );
      expect(remainingFiles).toEqual([
        {
          type: "file",
          file: {
            filename: "notes.txt",
            file_data: "data:text/plain;base64,bm90ZXM=",
          },
        },
      ]);
      expect(JSON.stringify(sandboxRequest)).toContain(
        "/home/user/upload/report.pdf",
      );
      expect(JSON.stringify(sandboxRequest)).toContain(
        MALFORMED_PDF_USER_RESPONSE,
      );
      expect(response.headers.get(PDF_PARSER_RECOVERY_HEADER)).toBe("sandbox");
    },
  );

  it("does not remove a PDF when no sandbox attachment path is available", async () => {
    const cloudflareError = parserErrorResponse(
      PDF_PARSER_INVALID_DOCUMENT_ERROR,
    );
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        parserErrorResponse(PDF_PARSER_INVALID_DOCUMENT_ERROR),
      )
      .mockResolvedValueOnce(cloudflareError);
    const patchedFetch = createOpenRouterPatchFetch(
      fetchMock as unknown as typeof fetch,
    );

    const response = await patchedFetch("https://openrouter.test/chat", {
      method: "POST",
      body: JSON.stringify(createPdfParserRequest(false)),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response).toBe(cloudflareError);
    expect(response.headers.get(PDF_PARSER_RECOVERY_HEADER)).toBeNull();
  });

  it("recovers directly to the sandbox when a later step already uses Cloudflare", async () => {
    const request = createPdfParserRequest();
    request.plugins[0].pdf.engine = "cloudflare-ai";
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        parserErrorResponse(PDF_PARSER_INVALID_DOCUMENT_ERROR),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const patchedFetch = createOpenRouterPatchFetch(
      fetchMock as unknown as typeof fetch,
    );

    const response = await patchedFetch("https://openrouter.test/chat", {
      method: "POST",
      body: JSON.stringify(request),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sandboxRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(sandboxRequest.plugins).toEqual([]);
    const remainingFiles = sandboxRequest.messages.flatMap(
      (message: { content?: Array<{ type?: string; file?: unknown }> }) =>
        (message.content ?? []).filter((part) => part.type === "file"),
    );
    expect(remainingFiles).toEqual([
      {
        type: "file",
        file: {
          filename: "notes.txt",
          file_data: "data:text/plain;base64,bm90ZXM=",
        },
      },
    ]);
    expect(response.headers.get(PDF_PARSER_RECOVERY_HEADER)).toBe("sandbox");
  });

  it("does not retry unrelated provider errors", async () => {
    const originalResponse = new Response(
      JSON.stringify({ error: { message: "Unrelated provider error" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
    const fetchMock = jest.fn().mockResolvedValueOnce(originalResponse);
    const patchedFetch = createOpenRouterPatchFetch(
      fetchMock as unknown as typeof fetch,
    );

    const response = await patchedFetch("https://openrouter.test/chat", {
      method: "POST",
      body: JSON.stringify(createPdfParserRequest()),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response).toBe(originalResponse);
  });

  it.each(["Failed to parse ", "Failed to parse : report.pdf"])(
    "falls back to sandbox paths for generic file parsing error %s",
    async (providerMessage) => {
      const genericParseError = new Response(
        JSON.stringify({ error: { message: providerMessage } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(genericParseError)
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));
      const patchedFetch = createOpenRouterPatchFetch(
        fetchMock as unknown as typeof fetch,
      );

      const response = await patchedFetch("https://openrouter.test/chat", {
        method: "POST",
        body: JSON.stringify(createPdfParserRequest()),
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const sandboxRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(
        sandboxRequest.messages.flatMap(
          (message: {
            content?: Array<{ type?: string; file?: { filename?: string } }>;
          }) =>
            (message.content ?? [])
              .filter((part) => part.type === "file")
              .map((part) => part.file?.filename),
        ),
      ).toEqual(["notes.txt"]);
      expect(JSON.stringify(sandboxRequest)).toContain(
        "inspect the files with sandbox tools",
      );
      expect(response.headers.get(PDF_PARSER_RECOVERY_HEADER)).toBe("sandbox");
    },
  );
});

describe("supportsMultimodalToolResults", () => {
  it("allows active Grok and Kimi routes for image tool results", () => {
    expect(supportsMultimodalToolResults("agent-model")).toBe(true);
    expect(supportsMultimodalToolResults("ask-model")).toBe(true);
    expect(supportsMultimodalToolResults("fallback-agent-model")).toBe(true);
    expect(supportsMultimodalToolResults("fallback-ask-model")).toBe(true);
    expect(supportsMultimodalToolResults("model-kimi-k3")).toBe(true);
    expect(supportsMultimodalToolResults("moonshotai/kimi-k3")).toBe(true);
  });

  it("allows active multimodal keys and slugs used after image tool results", () => {
    expect(supportsMultimodalToolResults("ask-model-free")).toBe(true);
    expect(supportsMultimodalToolResults("model-glm-5.3-flash")).toBe(true);
    expect(supportsMultimodalToolResults("model-glm-5.3-flash-pro")).toBe(true);
    expect(
      supportsMultimodalToolResults("model-deepseek-v4-flash-vision"),
    ).toBe(true);
    expect(supportsMultimodalToolResults(GLM_5_3_FLASH_SLUG)).toBe(true);
    expect(supportsMultimodalToolResults(DEEPSEEK_V4_FLASH_VISION_SLUG)).toBe(
      true,
    );
    expect(supportsMultimodalToolResults("model-grok-4.5")).toBe(true);
    expect(supportsMultimodalToolResults("model-grok-4.5-pro")).toBe(true);
    expect(supportsMultimodalToolResults("model-grok-4.6-pro")).toBe(true);
    expect(supportsMultimodalToolResults("x-ai/grok-4.5")).toBe(true);
    expect(supportsMultimodalToolResults("x-ai/grok-4.6")).toBe(true);
  });

  it("accepts free GLM Agent while rejecting text-only DeepSeek model keys", () => {
    expect(supportsMultimodalToolResults("agent-model-free")).toBe(true);
    expect(supportsMultimodalToolResults("model-glm-5.3-flash-agent")).toBe(
      true,
    );
    expect(supportsMultimodalToolResults("model-deepseek-v4-pro")).toBe(false);
    expect(supportsMultimodalToolResults("model-deepseek-v4-pro-0813")).toBe(
      false,
    );
  });

  it.each([
    "model-gemini-3-flash",
    "model-minimax-m3",
    "model-kimi-k2.6",
    "model-kimi-k2.7-code",
    "model-deepseek-v4-flash",
    "fallback-grok-4.5",
  ])("does not classify retired route %s as multimodal", (modelName) => {
    expect(supportsMultimodalToolResults(modelName)).toBe(false);
  });
});
