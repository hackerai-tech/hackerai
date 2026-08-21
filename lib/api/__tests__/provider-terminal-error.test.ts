import { wrapProviderTerminalError } from "../provider-terminal-error";

describe("wrapProviderTerminalError", () => {
  it("creates stable provider/model/category fingerprint fields and retains IDs", () => {
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
      "Provider terminal error provider=deepinfra model=deepseek_deepseek-v4-flash-0731 category=provider_5xx status=502",
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

  it("produces a different Trigger fingerprint message for xAI failures", () => {
    const error = wrapProviderTerminalError(
      Object.assign(new Error("Internal error during token generation"), {
        statusCode: 502,
      }),
      {
        model: "x-ai/grok-4.5",
        openRouterMetadata: { provider_name: "xAI" },
      },
    );

    expect(error.message).toBe(
      "Provider terminal error provider=xai model=x-ai_grok-4.5 category=provider_5xx status=502",
    );
  });
});
