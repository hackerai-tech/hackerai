import { wrapProviderTerminalError } from "../provider-terminal-error";

describe("wrapProviderTerminalError", () => {
  it("uses a low-cardinality fingerprint while retaining provider diagnostics", () => {
    const cause = Object.assign(new Error("Network connection lost."), {
      statusCode: 502,
    });
    const error = wrapProviderTerminalError(cause, {
      model: "deepseek/deepseek-v4-flash-0731",
      openRouterMetadata: {
        provider_name: "DeepInfra",
        openrouter_generation_id: "gen-1",
        openrouter_request_id: "req-1",
        openrouter_upstream_id: "upstream-1",
      },
    });

    expect(error.message).toBe(
      "Provider terminal error category=provider_5xx status=502",
    );
    expect(error).toMatchObject({
      name: "ProviderTerminalError",
      provider: "DeepInfra",
      model: "deepseek/deepseek-v4-flash-0731",
      category: "provider_5xx",
      statusCode: 502,
      openrouterGenerationId: "gen-1",
      openrouterRequestId: "req-1",
      openrouterUpstreamId: "upstream-1",
      cause,
    });
  });

  it("groups providers and models that share the same terminal category", () => {
    const deepInfraError = wrapProviderTerminalError(
      Object.assign(new Error("Network connection lost."), {
        statusCode: 502,
      }),
      {
        model: "deepseek/deepseek-v4-flash-0731",
        openRouterMetadata: { provider_name: "DeepInfra" },
      },
    );
    const xaiError = wrapProviderTerminalError(
      Object.assign(new Error("Internal error during token generation"), {
        statusCode: 502,
      }),
      {
        model: "x-ai/grok-4.5",
        openRouterMetadata: { provider_name: "xAI" },
      },
    );

    expect(xaiError.message).toBe(deepInfraError.message);
    expect(xaiError).toMatchObject({
      provider: "xAI",
      model: "x-ai/grok-4.5",
    });
    expect(deepInfraError).toMatchObject({
      provider: "DeepInfra",
      model: "deepseek/deepseek-v4-flash-0731",
    });
    expect(xaiError.message).toBe(
      "Provider terminal error category=provider_5xx status=502",
    );
  });

  it("distinguishes local aggregate-size rejections from upstream 413s", () => {
    const localAttempt = Object.assign(new Error("Request too large"), {
      statusCode: 413,
      responseHeaders: {
        "X-HackerAI-OpenRouter-Request-Size-Guard": "rejected",
        "X-HackerAI-OpenRouter-Request-Bytes-Before": "7083624",
        "X-HackerAI-OpenRouter-Request-Bytes-After": "6012345",
        "X-HackerAI-OpenRouter-Request-Limit-Bytes": "5242880",
        "X-HackerAI-Request-Id": "size-guard-1",
      },
    });
    const localRejection = wrapProviderTerminalError(
      Object.assign(new Error("Failed after 3 attempts"), {
        errors: [localAttempt],
      }),
      { model: "deepseek/deepseek-v4-flash-0731" },
    );
    const upstreamRejection = wrapProviderTerminalError(
      Object.assign(new Error("Provider request too large"), {
        statusCode: 413,
      }),
      { model: "deepseek/deepseek-v4-flash-0731" },
    );

    expect(localRejection.message).toBe(
      "Provider terminal error category=provider_4xx origin=local_request_size_guard status=413",
    );
    expect(localRejection.origin).toBe("local_request_size_guard");
    expect(localRejection).toMatchObject({
      localRequestId: "size-guard-1",
      requestBytesBefore: 7_083_624,
      requestBytesAfter: 6_012_345,
      requestLimitBytes: 5_242_880,
    });
    expect(upstreamRejection.message).toBe(
      "Provider terminal error category=provider_4xx status=413",
    );
    expect(upstreamRejection.origin).toBeUndefined();
  });
});
