import { describe, expect, it, jest } from "@jest/globals";
import {
  fetchOrcaRouterCatalog,
  ORCAROUTER_FALLBACK_MODELS,
  parseOrcaRouterCatalog,
} from "@/lib/ai/orcarouter/catalog";
import { filterOrcaRouterModels } from "@/lib/ai/orcarouter/models";

const { Response: EdgeResponse } =
  require("next/dist/compiled/@edge-runtime/primitives/fetch") as {
    Response: typeof Response;
  };

// One record per capability the relay advertises.
const catalogFixture = {
  data: [
    {
      id: "deepseek/deepseek-v4-pro",
      supported_endpoint_types: ["openai", "openai-response"],
      architecture: { input_modalities: ["text"] },
    },
    {
      id: "openai/gpt-5.5",
      supported_endpoint_types: ["openai", "anthropic"],
      architecture: { input_modalities: ["text", "image"] },
    },
    {
      id: "orcarouter/auto",
      supported_endpoint_types: ["openai", "gemini"],
    },
    {
      id: "openai/text-embedding-3-large",
      supported_endpoint_types: ["embeddings"],
    },
    {
      id: "openai/gpt-image-2",
      supported_endpoint_types: ["image-generation"],
    },
    { id: "openai/sora-3", supported_endpoint_types: ["openai-video"] },
    { id: "jina/reranker-v3", supported_endpoint_types: ["jina-rerank"] },
    { id: "not a model id", supported_endpoint_types: ["openai"] },
    { id: "openai/gpt-5.5", supported_endpoint_types: ["openai"] },
  ],
};

const API_BASE = "https://api.orcarouter.ai/v1";

describe("OrcaRouter catalog", () => {
  it("keeps only chat models and their declared modalities", () => {
    expect(parseOrcaRouterCatalog(catalogFixture)).toEqual([
      { id: "deepseek/deepseek-v4-pro", inputModalities: ["text"] },
      { id: "openai/gpt-5.5", inputModalities: ["text", "image"] },
      { id: "orcarouter/auto", inputModalities: [] },
    ]);
  });

  it("fails closed for image turns when modalities are undeclared", () => {
    const models = parseOrcaRouterCatalog(catalogFixture);
    expect(filterOrcaRouterModels(models, "image-chat")).toEqual([
      { id: "openai/gpt-5.5", inputModalities: ["text", "image"] },
    ]);
  });

  it("requests the chat catalog from the API origin with the user's key", async () => {
    const fetchImpl = jest.fn(
      async (_input: unknown, _init?: RequestInit) =>
        new EdgeResponse(JSON.stringify(catalogFixture), { status: 200 }),
    );
    const catalog = await fetchOrcaRouterCatalog({
      apiBaseUrl: API_BASE,
      apiKey: "sk-orca-test",
      capability: "chat",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(catalog.status).toBe("live");
    expect(catalog.models.map((model) => model.id)).toEqual([
      "deepseek/deepseek-v4-pro",
      "openai/gpt-5.5",
      "orcarouter/auto",
    ]);
    const [input, init] = fetchImpl.mock.calls[0];
    expect(String(input)).toBe(
      "https://api.orcarouter.ai/v1/models?capability=chat",
    );
    expect(init?.headers).toEqual({ Authorization: "Bearer sk-orca-test" });
  });

  it("reports a revoked key without falling back", async () => {
    const fetchImpl = jest.fn(
      async () => new EdgeResponse("{}", { status: 401 }),
    );
    await expect(
      fetchOrcaRouterCatalog({
        apiBaseUrl: API_BASE,
        apiKey: "sk-orca-revoked",
        capability: "chat",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ status: "unauthorized", models: [] });
  });

  it("falls back to the verified seed on network failure", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const catalog = await fetchOrcaRouterCatalog({
      apiBaseUrl: API_BASE,
      apiKey: "sk-orca-test",
      capability: "image-chat",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(catalog).toEqual({
      status: "fallback",
      reason: "network",
      models: ORCAROUTER_FALLBACK_MODELS.filter((model) =>
        model.inputModalities.includes("image"),
      ),
    });
  });

  it("falls back on malformed or oversized responses", async () => {
    const malformed = jest.fn(
      async () => new EdgeResponse('{"data": "nope"}', { status: 200 }),
    );
    await expect(
      fetchOrcaRouterCatalog({
        apiBaseUrl: API_BASE,
        apiKey: "k",
        capability: "chat",
        fetchImpl: malformed as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ status: "fallback", reason: "malformed" });

    const oversized = jest.fn(
      async () =>
        new EdgeResponse("{}", {
          status: 200,
          headers: { "content-length": String(10 * 1024 * 1024) },
        }),
    );
    await expect(
      fetchOrcaRouterCatalog({
        apiBaseUrl: API_BASE,
        apiKey: "k",
        capability: "chat",
        fetchImpl: oversized as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ status: "fallback", reason: "malformed" });
  });
});
