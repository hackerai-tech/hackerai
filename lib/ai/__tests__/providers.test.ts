import {
  AUXILIARY_VISION_SLUG,
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
  PDF_PARSER_ENGINE_HEADER,
  PDF_PARSER_RECOVERY_HEADER,
  sanitizeOpenRouterRequestForXai,
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
    ).toBe("deepseek/deepseek-v4-flash");
    expect(
      (myProvider.languageModel("agent-model-free") as { modelId: string })
        .modelId,
    ).toBe("deepseek/deepseek-v4-flash-0731");
    expect(
      (
        myProvider.languageModel("auxiliary-vision-model") as {
          modelId: string;
        }
      ).modelId,
    ).toBe("xiaomi/mimo-v2.5");
    expect(AUXILIARY_VISION_SLUG).toBe("xiaomi/mimo-v2.5");
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
    expect(isDeepSeekModel("model-deepseek-v4-flash-0731")).toBe(true);
    expect(isDeepSeekModel("model-deepseek-v4-pro")).toBe(true);
    expect(isDeepSeekModel("model-deepseek-v4-pro-0813")).toBe(true);
    expect(isDeepSeekModel("agent-auto-review-model")).toBe(true);
  });

  it("keeps tracked free routes split by mode", () => {
    const provider = createTrackedProvider();
    expect(
      (provider.languageModel("ask-model-free") as { modelId: string }).modelId,
    ).toBe("deepseek/deepseek-v4-flash");
    expect(
      (provider.languageModel("agent-model-free") as { modelId: string })
        .modelId,
    ).toBe("deepseek/deepseek-v4-flash-0731");
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

describe("sanitizeOpenRouterRequestForXai", () => {
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
      model: "moonshotai/kimi-k3",
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

    const result = sanitizeOpenRouterRequestForXai(body);

    expect(result.changed).toBe(false);
    expect(result.body).toBe(body);
    expect(JSON.stringify(result.body)).toContain("user-owned-data");
    expect(JSON.stringify(result.body)).toContain(
      "user-owned-reasoning-shaped-data",
    );
    expect(JSON.stringify(result.body)).toContain("tool-owned-data");
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
    const originalResponse = parserErrorResponse("Unrelated provider error");
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
    expect(supportsMultimodalToolResults("model-grok-4.5")).toBe(true);
    expect(supportsMultimodalToolResults("model-grok-4.5-pro")).toBe(true);
    expect(supportsMultimodalToolResults("model-grok-4.6-pro")).toBe(true);
    expect(supportsMultimodalToolResults("x-ai/grok-4.5")).toBe(true);
    expect(supportsMultimodalToolResults("x-ai/grok-4.6")).toBe(true);
  });

  it("rejects text-only DeepSeek model keys", () => {
    expect(supportsMultimodalToolResults("agent-model-free")).toBe(false);
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
