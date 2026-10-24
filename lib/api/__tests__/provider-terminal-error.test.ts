import {
  getTerminalProviderStreamError,
  getProviderDisconnectIgnoredSlugs,
  wrapProviderTerminalError,
} from "../provider-terminal-error";

describe("getProviderDisconnectIgnoredSlugs", () => {
  const disconnect = Object.assign(new TypeError("terminated"), {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });

  it("avoids the observed upstream only after a transport failure", () => {
    expect(
      getProviderDisconnectIgnoredSlugs(disconnect, {
        provider_name: "Together",
      }),
    ).toEqual(["together"]);
    expect(
      getProviderDisconnectIgnoredSlugs(
        Object.assign(new Error("Invalid request"), { statusCode: 400 }),
        { provider_name: "Together" },
      ),
    ).toEqual([]);
  });

  it.each([undefined, "unknown", "deepseek", "Unmapped Provider"])(
    "does not infer an upstream slug from %s",
    (provider_name) => {
      expect(
        getProviderDisconnectIgnoredSlugs(disconnect, { provider_name }),
      ).toEqual([]);
    },
  );

  it.each([502, 503, 504])(
    "avoids Together after an eligible numeric SSE %s failure",
    (code) => {
      expect(
        getProviderDisconnectIgnoredSlugs(
          { code, message: "Upstream unavailable" },
          {
            provider_name: "Together",
          },
        ),
      ).toEqual(["together"]);
    },
  );

  it("does not exclude an upstream for a bare abort", () => {
    expect(
      getProviderDisconnectIgnoredSlugs(
        Object.assign(new Error("The operation was aborted"), {
          name: "AbortError",
        }),
        { provider_name: "Together" },
      ),
    ).toEqual([]);
  });
});

describe("wrapProviderTerminalError", () => {
  it("does not attach a completed provider's identifiers to a new rejection", () => {
    const cause = Object.assign(new Error("Provider returned error"), {
      statusCode: 400,
      data: {
        error: {
          code: 400,
          metadata: { provider_name: "Z.AI", raw: "private failure detail" },
        },
      },
    });
    const previous = Object.freeze({
      provider_name: "Fireworks",
      openrouter_selected_model: "previous/model",
      openrouter_generation_id: "gen-previous",
      openrouter_request_id: "request-previous",
      openrouter_upstream_id: "upstream-previous",
    });

    const error = wrapProviderTerminalError(cause, {
      model: "configured-model",
      openRouterMetadata: previous,
    });

    expect(error).toMatchObject({
      provider: "Z.AI",
      model: "configured-model",
      category: "provider_4xx",
      statusCode: 400,
      cause,
    });
    expect(error.openrouterGenerationId).toBeUndefined();
    expect(error.openrouterRequestId).toBeUndefined();
    expect(error.openrouterUpstreamId).toBeUndefined();
    expect(error.message).toBe(
      "Provider terminal error category=provider_4xx status=400",
    );
    expect(JSON.stringify(error)).not.toContain("private failure detail");
    expect(wrapProviderTerminalError(error, {})).toBe(error);
  });

  it.each([{ id: "gen-current" }, { request_id: "request-current" }])(
    "keeps a rejected request separate from earlier routing: %j",
    (metadata) => {
      const cause = Object.assign(new Error("Provider returned error"), {
        statusCode: 400,
        responseBody: JSON.stringify({ ...metadata, error: { code: 400 } }),
      });
      const error = wrapProviderTerminalError(cause, {
        model: "configured-model",
        openRouterMetadata: {
          provider_name: "Earlier provider",
          openrouter_selected_model: "previous/model",
          openrouter_generation_id: "gen-previous",
          openrouter_request_id: "request-previous",
          openrouter_upstream_id: "upstream-previous",
        },
      });

      expect(error.provider).toBe("unknown");
      expect(error.model).toBe("configured-model");
      expect(error.openrouterGenerationId).toBe(metadata.id);
      expect(error.openrouterRequestId).toBe(metadata.request_id);
      expect(error.openrouterUpstreamId).toBeUndefined();
      expect(error.cause).toBe(cause);
    },
  );

  it("retains compatible response attribution when the error only adds its request ID", () => {
    const cause = Object.assign(new Error("Provider returned error"), {
      statusCode: 502,
      responseHeaders: { "x-request-id": "request-current" },
    });
    const error = wrapProviderTerminalError(cause, {
      model: "configured-model",
      openRouterMetadata: {
        provider_name: "Current provider",
        openrouter_selected_model: "current/model",
        openrouter_generation_id: "gen-current",
        openrouter_request_id: "request-current",
        openrouter_upstream_id: "upstream-current",
      },
    });

    expect(error).toMatchObject({
      provider: "Current provider",
      model: "current/model",
      openrouterGenerationId: "gen-current",
      openrouterRequestId: "request-current",
      openrouterUpstreamId: "upstream-current",
      category: "provider_5xx",
      cause,
    });
  });

  it("can prepare recovery diagnostics when an empty stream has no provider error", () => {
    const state = { providerError: undefined };
    const error = wrapProviderTerminalError(state.providerError, {
      model: "test/model",
    });
    expect(error).toMatchObject({
      name: "ProviderTerminalError",
      message: "Provider terminal error category=unknown",
      category: "unknown",
      model: "test/model",
    });
    expect(error.cause).toBeUndefined();
    expect(wrapProviderTerminalError(error, {})).toBe(error);
  });

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

describe("getTerminalProviderStreamError", () => {
  it.each(["error", "content-filter"])(
    "preserves %s observed before cancellation",
    (streamFinishReason) => {
      expect(
        getTerminalProviderStreamError(
          {
            providerError: undefined,
            streamFinishReason: undefined,
            providerTerminalFinishReasonBeforeAbort: streamFinishReason,
          },
          true,
        ),
      ).toBeInstanceOf(Error);
      expect(
        getTerminalProviderStreamError(
          {
            providerError: undefined,
            streamFinishReason,
            providerTerminalFinishReasonBeforeAbort: undefined,
          },
          true,
        ),
      ).toBeUndefined();
      expect(
        getTerminalProviderStreamError(
          { providerError: undefined, streamFinishReason },
          false,
        ),
      ).toBeInstanceOf(Error);
    },
  );
  it("preserves a captured error even if finish occurs after cancellation", () => {
    const error = new Error("Upstream unavailable");
    expect(
      getTerminalProviderStreamError(
        {
          providerError: error,
          streamFinishReason: "error",
          providerTerminalFinishReasonBeforeAbort: undefined,
        },
        true,
      ),
    ).toBe(error);
  });
});
