import {
  sanitizeOpenRouterRequestForGeminiFunctionResponses,
  sanitizeOpenRouterRequestForXai,
  supportsMultimodalToolResults,
} from "@/lib/ai/providers";

describe("sanitizeOpenRouterRequestForXai", () => {
  it("strips encrypted reasoning details when an OpenRouter fallback can route to xAI", () => {
    const body = {
      model: "google/gemini-3-flash-preview",
      models: ["x-ai/grok-4.3"],
      messages: [
        {
          role: "assistant",
          content: "Here is the answer.",
          reasoning_details: [
            { type: "text", text: "plain reasoning detail" },
            {
              type: "encrypted",
              encrypted_content: "provider-private-gemini-blob",
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
      model: "google/gemini-3-flash-preview",
      messages: [
        {
          role: "assistant",
          content: "Here is the answer.",
          reasoning_details: [
            { type: "encrypted", encrypted_content: "gemini-blob" },
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

describe("sanitizeOpenRouterRequestForGeminiFunctionResponses", () => {
  it("wraps JSON tool responses with OpenAPI $ref keys when a fallback can route to Gemini", () => {
    const openApiResponse = JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/auth": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/AuthRequest" },
                },
              },
            },
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      $ref: "#/components/schemas/CoreAuthenticationResult",
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const body = {
      model: "deepseek/deepseek-v4-flash",
      models: ["google/gemini-3-flash-preview"],
      messages: [
        {
          role: "tool",
          tool_call_id: "call_1",
          name: "open_url",
          content: openApiResponse,
        },
      ],
    };

    const result = sanitizeOpenRouterRequestForGeminiFunctionResponses(body);

    expect(result.changed).toBe(true);
    expect((result.body as any).messages[0].content).toBe(
      JSON.stringify({ result: openApiResponse }),
    );
    expect(JSON.parse((result.body as any).messages[0].content)).toEqual({
      result: openApiResponse,
    });
  });

  it("leaves non-Gemini routes and non-ref JSON tool responses unchanged", () => {
    const nonGeminiBody = {
      model: "deepseek/deepseek-v4-flash",
      messages: [
        {
          role: "tool",
          tool_call_id: "call_1",
          name: "open_url",
          content: JSON.stringify({ $ref: "#/components/schemas/AuthRequest" }),
        },
      ],
    };
    const geminiBodyWithoutRef = {
      model: "google/gemini-3-flash-preview",
      messages: [
        {
          role: "tool",
          tool_call_id: "call_1",
          name: "web_search",
          content: JSON.stringify({ result: "ok" }),
        },
      ],
    };

    expect(
      sanitizeOpenRouterRequestForGeminiFunctionResponses(nonGeminiBody),
    ).toEqual({ body: nonGeminiBody, changed: false });
    expect(
      sanitizeOpenRouterRequestForGeminiFunctionResponses(geminiBodyWithoutRef),
    ).toEqual({ body: geminiBodyWithoutRef, changed: false });
  });
});

describe("supportsMultimodalToolResults", () => {
  it("allows Kimi registry keys and OpenRouter slugs for image tool result experiments", () => {
    expect(supportsMultimodalToolResults("model-kimi-k2.6")).toBe(true);
    expect(supportsMultimodalToolResults("agent-model")).toBe(true);
    expect(supportsMultimodalToolResults("moonshotai/kimi-k2.6:exacto")).toBe(
      true,
    );
  });

  it("still rejects text-only DeepSeek routes", () => {
    expect(supportsMultimodalToolResults("agent-model-free")).toBe(false);
    expect(supportsMultimodalToolResults("model-deepseek-v4-flash")).toBe(
      false,
    );
    expect(supportsMultimodalToolResults("model-deepseek-v4-pro")).toBe(false);
  });
});
