import {
  extractOpenRouterMetadata,
  fetchOpenRouterGenerationMetadata,
  mergeOpenRouterMetadata,
} from "../openrouter-metadata";

describe("OpenRouter metadata extraction", () => {
  it("extracts generation and selected provider metadata from the finish result", () => {
    const metadata = extractOpenRouterMetadata({
      response: {
        id: "gen-from-body",
        headers: {
          "x-generation-id": "gen-from-header",
          "request-id": "req-from-header",
        },
      },
      providerMetadata: {
        openrouter: {
          openrouter_metadata: {
            strategy: "direct",
            region: "iad",
            attempt: 1,
            is_byok: false,
            endpoints: {
              available: [
                {
                  provider: "Anthropic Vertex",
                  model: "anthropic/claude-opus-4.6",
                  selected: true,
                },
              ],
            },
            attempts: [
              {
                provider: "Anthropic Vertex",
                model: "anthropic/claude-opus-4.6",
                status: 200,
              },
            ],
          },
        },
      },
    });

    expect(metadata).toEqual({
      provider_name: "Anthropic Vertex",
      openrouter_generation_id: "gen-from-header",
      openrouter_request_id: "req-from-header",
      openrouter_is_byok: false,
      openrouter_strategy: "direct",
      openrouter_region: "iad",
      openrouter_attempt: 1,
      openrouter_selected_model: "anthropic/claude-opus-4.6",
      openrouter_attempts: [
        {
          provider: "Anthropic Vertex",
          model: "anthropic/claude-opus-4.6",
          status: 200,
        },
      ],
    });
  });

  it("uses generation API metadata when stream metadata is incomplete", async () => {
    const fetchImpl = jest.fn(async () => {
      return {
        ok: true,
        json: async () => ({
          data: {
            provider_name: "Azure",
            request_id: "req-openrouter",
            is_byok: true,
            router: "openrouter/auto",
            upstream_id: "chatcmpl-upstream",
          },
        }),
      } as Response;
    });

    const metadata = await fetchOpenRouterGenerationMetadata("gen-123", {
      apiKey: "sk-test",
      fetchImpl,
      timeoutMs: 100,
    });

    expect(metadata).toEqual({
      provider_name: "Azure",
      openrouter_generation_id: "gen-123",
      openrouter_request_id: "req-openrouter",
      openrouter_is_byok: true,
      openrouter_router: "openrouter/auto",
      openrouter_upstream_id: "chatcmpl-upstream",
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("id=gen-123");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test",
    );
  });

  it("extracts the direct provider field exposed by the OpenRouter SDK", () => {
    const metadata = extractOpenRouterMetadata({
      response: {
        id: "gen-sdk-provider",
      },
      providerMetadata: {
        openrouter: {
          provider: "Google Vertex",
          usage: {
            promptTokens: 10,
            completionTokens: 1,
            totalTokens: 11,
          },
        },
      },
    });

    expect(metadata).toEqual({
      provider_name: "Google Vertex",
      openrouter_generation_id: "gen-sdk-provider",
    });
  });

  it("merges generation metadata without overwriting response metadata", () => {
    const merged = mergeOpenRouterMetadata(
      {
        openrouter_generation_id: "gen-123",
        provider_name: "Google Vertex",
        openrouter_strategy: "direct",
      },
      {
        openrouter_generation_id: "gen-123",
        provider_name: "Google",
        openrouter_request_id: "req-123",
        openrouter_router: "openrouter/auto",
      },
    );

    expect(merged).toEqual({
      openrouter_generation_id: "gen-123",
      provider_name: "Google Vertex",
      openrouter_strategy: "direct",
      openrouter_request_id: "req-123",
      openrouter_router: "openrouter/auto",
    });
  });
});
