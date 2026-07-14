import {
  extractOpenRouterMetadata,
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
});
