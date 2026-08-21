import {
  extractOpenRouterMetadata,
  extractOpenRouterMetadataFromError,
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

  it("extracts the direct provider field exposed by the OpenRouter SDK", () => {
    const metadata = extractOpenRouterMetadata({
      response: {
        id: "gen-sdk-provider",
      },
      providerMetadata: {
        openrouter: {
          provider: "Google Vertex",
          upstreamInferenceCost: 0.00016,
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
      openrouter_upstream_inference_cost: 0.00016,
    });
  });

  it("extracts camelCase upstream cost from direct OpenRouter SDK metadata", () => {
    const metadata = extractOpenRouterMetadata({
      response: {
        id: "gen-sdk-cost-only",
      },
      providerMetadata: {
        openrouter: {
          upstreamInferenceCost: 0.00016,
        },
      },
    });

    expect(metadata).toEqual({
      openrouter_generation_id: "gen-sdk-cost-only",
      openrouter_upstream_inference_cost: 0.00016,
    });
  });

  it("ignores non-positive upstream inference costs from provider metadata", () => {
    const metadata = extractOpenRouterMetadata({
      response: {
        id: "gen-zero-cost",
      },
      providerMetadata: {
        openrouter: {
          provider: "Anthropic",
          upstream_inference_cost: 0,
          upstreamInferenceCost: Number.NaN,
        },
      },
    });

    expect(metadata).toEqual({
      provider_name: "Anthropic",
      openrouter_generation_id: "gen-zero-cost",
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
        openrouter_upstream_inference_cost: 0.00016,
      },
    );

    expect(merged).toEqual({
      openrouter_generation_id: "gen-123",
      provider_name: "Google Vertex",
      openrouter_strategy: "direct",
      openrouter_request_id: "req-123",
      openrouter_router: "openrouter/auto",
      openrouter_upstream_inference_cost: 0.00016,
    });
  });

  it("fills provider attribution from step metadata when finish metadata only has IDs", () => {
    const finishMetadata = extractOpenRouterMetadata({
      response: {
        id: "gen-finish-only",
      },
      providerMetadata: {
        openrouter: {
          usage: {
            promptTokens: 10,
            completionTokens: 1,
            totalTokens: 11,
          },
        },
      },
    });
    const stepMetadata = extractOpenRouterMetadata({
      providerMetadata: {
        openrouter: {
          provider: "Novita",
        },
      },
    });

    expect(mergeOpenRouterMetadata(finishMetadata, stepMetadata)).toEqual({
      openrouter_generation_id: "gen-finish-only",
      provider_name: "Novita",
    });
  });

  it("extracts response IDs and upstream attribution from wrapped stream errors", () => {
    const error = Object.assign(new Error("Network connection lost."), {
      responseHeaders: {
        "x-generation-id": "gen-stream-failure",
        "x-request-id": "req-stream-failure",
      },
      data: {
        error: {
          code: 502,
          message: "Network connection lost.",
          metadata: { provider_name: "DeepInfra" },
        },
        openrouter_metadata: {
          request_id: "req-router-metadata",
          upstream_id: "upstream-deepseek-1",
          router: "openrouter/auto",
        },
      },
    });

    expect(extractOpenRouterMetadataFromError(error)).toEqual({
      provider_name: "DeepInfra",
      openrouter_generation_id: "gen-stream-failure",
      openrouter_request_id: "req-router-metadata",
      openrouter_router: "openrouter/auto",
      openrouter_upstream_id: "upstream-deepseek-1",
    });
  });

  it("looks up generation request and upstream IDs without exposing credentials", async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          id: "gen-stream-failure",
          provider_name: "DeepInfra",
          request_id: "req-generation-record",
          upstream_id: "upstream-generation-record",
          router: "openrouter/auto",
          model: "deepseek/deepseek-v4-flash-0731",
        },
      }),
    }));

    await expect(
      fetchOpenRouterGenerationMetadata("gen-stream-failure", {
        apiKey: "test-secret",
        fetch: fetchMock,
      }),
    ).resolves.toEqual({
      provider_name: "DeepInfra",
      openrouter_generation_id: "gen-stream-failure",
      openrouter_request_id: "req-generation-record",
      openrouter_router: "openrouter/auto",
      openrouter_upstream_id: "upstream-generation-record",
      openrouter_selected_model: "deepseek/deepseek-v4-flash-0731",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/generation?id=gen-stream-failure",
      expect.objectContaining({
        headers: { Authorization: "Bearer test-secret" },
      }),
    );
  });
});
