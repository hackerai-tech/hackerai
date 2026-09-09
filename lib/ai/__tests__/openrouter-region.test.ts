/** @jest-environment node */
import { jest } from "@jest/globals";
import { generateText } from "ai";
import { createTrackedProvider, myProvider } from "../providers";
import {
  createEuModelCatalog,
  createOpenRouterRegionFetch,
  isEuropeanRequest,
} from "../openrouter-region";

const globalUrl = "https://openrouter.ai/api/v1/chat/completions";
const euUrl = "https://eu.openrouter.ai/api/v1/chat/completions";
const init: RequestInit = {
  method: "POST",
  headers: {
    Authorization: "Bearer test",
    "X-OpenRouter-Experimental-Metadata": "enabled",
  },
  body: JSON.stringify({
    model: "z-ai/glm-5.2",
    models: ["x-ai/grok-4.5"],
    messages: [{ role: "user", content: "test" }],
    stream: true,
    provider: { ignore: ["example"] },
  }),
};

describe("European user detection", () => {
  it.each([
    ["EU", true],
    [" eu ", true],
    ["NA", false],
    ["AS", false],
    ["", false],
  ])("handles continent %s", (continent, expected) => {
    expect(
      isEuropeanRequest({
        headers: new Headers({ "x-vercel-ip-continent": String(continent) }),
      }),
    ).toBe(expected);
  });
  it("defaults missing geography to global", () => {
    expect(isEuropeanRequest({ headers: new Headers() })).toBe(false);
  });
});

describe("OpenRouter regional transport", () => {
  const inference = jest.fn<typeof fetch>();
  const catalog = jest.fn<() => Promise<Set<string> | null>>();
  const onRoute = jest.fn();
  const success = () =>
    new Response("data: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
  let transport: typeof fetch;
  beforeEach(() => {
    inference.mockReset().mockImplementation(async () => success());
    catalog.mockReset().mockResolvedValue(new Set(["z-ai/glm-5.2"]));
    onRoute.mockReset();
    transport = createOpenRouterRegionFetch(
      inference,
      { preferEurope: true, onRoute },
      catalog,
    );
  });

  it("sends eligible models to EU without modifying body, headers, or signal", async () => {
    const requestInit = { ...init, signal: new AbortController().signal };
    const result = await transport(globalUrl, requestInit);
    expect(String(inference.mock.calls[0][0])).toBe(euUrl);
    expect(inference.mock.calls[0][1]).toBe(requestInit);
    expect(result.bodyUsed).toBe(false);
    expect(inference).toHaveBeenCalledTimes(1);
    expect(onRoute).toHaveBeenCalledWith("eu");
  });

  it("uses global when disabled without fetching the catalog", async () => {
    await createOpenRouterRegionFetch(inference, {}, catalog)(globalUrl, init);
    expect(inference).toHaveBeenCalledWith(globalUrl, init);
    expect(catalog).not.toHaveBeenCalled();
  });

  it.each([null, new Set<string>()])(
    "uses global when the catalog has no EU endpoint",
    async (models) => {
      catalog.mockResolvedValue(models);
      await transport(globalUrl, init);
      expect(inference).toHaveBeenCalledWith(globalUrl, init);
      expect(onRoute).not.toHaveBeenCalled();
    },
  );

  it("keeps the primary model global even if a fallback is EU-eligible", async () => {
    const body = JSON.stringify({
      model: "x-ai/grok-4.5",
      models: ["z-ai/glm-5.2"],
    });
    await transport(globalUrl, { ...init, body });
    expect(inference.mock.calls[0][0]).toBe(globalUrl);
  });

  it.each([404, 503])(
    "retries an EU endpoint availability error (%s) globally exactly once",
    async (status) => {
      inference.mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: status,
              message: "No endpoints found for this model",
            },
          },
          { status },
        ),
      );
      await transport(globalUrl, init);
      expect(inference).toHaveBeenCalledTimes(2);
      expect(String(inference.mock.calls[0][0])).toBe(euUrl);
      expect(inference.mock.calls[1]).toEqual([globalUrl, init]);
      expect(onRoute.mock.calls).toEqual([["eu"], ["global_no_eu_endpoint"]]);
    },
  );

  it("falls back when the account has no allowed provider in EU", async () => {
    inference.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: 404,
            message:
              "No allowed providers are available for the selected model. Providers serving this model: mistral, but your account's allowed-providers setting permits only: z-ai.",
          },
        },
        { status: 404 },
      ),
    );
    await transport(globalUrl, init);
    expect(inference).toHaveBeenCalledTimes(2);
    expect(inference.mock.calls[1]).toEqual([globalUrl, init]);
  });

  it.each([400, 401, 402, 403, 404, 429, 500, 502])(
    "preserves unrelated HTTP %s failures and their readable bodies",
    async (status) => {
      const response = Response.json(
        { error: { message: "Unrelated failure" } },
        { status },
      );
      inference.mockResolvedValueOnce(response);
      expect(await transport(globalUrl, init)).toBe(response);
      expect(await response.json()).toEqual({
        error: { message: "Unrelated failure" },
      });
      expect(inference).toHaveBeenCalledTimes(1);
    },
  );

  it("never replays SSE errors in an accepted stream", async () => {
    const response = new Response('data: {"error":{"code":503}}\n\n');
    inference.mockResolvedValueOnce(response);
    expect(await transport(globalUrl, init)).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(inference).toHaveBeenCalledTimes(1);
  });

  it("does not forward requests for other hosts or endpoints to EU", async () => {
    for (const url of [
      "https://example.com/api/v1/chat/completions",
      "https://openrouter.ai/api/v1/models",
    ]) {
      await transport(url, init);
      expect(inference).toHaveBeenLastCalledWith(url, init);
    }
    expect(catalog).not.toHaveBeenCalled();
  });

  it("honors cancellation during catalog lookup without sending inference", async () => {
    const controller = new AbortController();
    catalog.mockImplementation(async () => {
      controller.abort();
      return new Set(["z-ai/glm-5.2"]);
    });
    await expect(
      transport(globalUrl, { ...init, signal: controller.signal }),
    ).rejects.toThrow();
    expect(inference).not.toHaveBeenCalled();
  });

  it("never retries a network failure with unknown inference status", async () => {
    inference.mockRejectedValueOnce(new Error("Network failure"));
    await expect(transport(globalUrl, init)).rejects.toThrow("Network failure");
    expect(inference).toHaveBeenCalledTimes(1);
  });

  it("does not let analytics failures block inference", async () => {
    onRoute.mockImplementation(() => {
      throw new Error("Analytics failure");
    });
    await expect(transport(globalUrl, init)).resolves.toBeInstanceOf(Response);
  });
});

describe("EU model catalog", () => {
  afterEach(() => jest.restoreAllMocks());
  it("deduplicates concurrent reads and refreshes after five minutes", async () => {
    let now = 100;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const fetchCatalog = jest
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ data: [{ id: "model-a" }] }),
      );
    const load = createEuModelCatalog(fetchCatalog);
    expect(await Promise.all([load(), load(), load()])).toEqual([
      new Set(["model-a"]),
      new Set(["model-a"]),
      new Set(["model-a"]),
    ]);
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    await load();
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    now += 5 * 60_000;
    await load();
    expect(fetchCatalog).toHaveBeenCalledTimes(2);
    expect(fetchCatalog.mock.calls[0][1]).toEqual({
      signal: expect.any(AbortSignal),
    });
  });

  it.each([null, { data: [null] }, { data: [{ name: "missing-id" }] }])(
    "falls back on malformed catalogs and backs off retries",
    async (body) => {
      const fetchCatalog = jest
        .fn<typeof fetch>()
        .mockImplementation(async () => Response.json(body));
      const load = createEuModelCatalog(fetchCatalog);
      expect(await load()).toBeNull();
      expect(await load()).toBeNull();
      expect(fetchCatalog).toHaveBeenCalledTimes(1);
    },
  );

  it("recovers from a failed catalog lookup after thirty seconds", async () => {
    let now = 100;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const fetchCatalog = jest
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("Timeout"))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "model-a" }] }));
    const load = createEuModelCatalog(fetchCatalog);
    expect(await load()).toBeNull();
    now += 30_000;
    expect(await load()).toEqual(new Set(["model-a"]));
  });
});

describe("OpenRouter SDK integration", () => {
  it("preserves direct-provider models when creating an EU-aware provider", () => {
    const provider = createTrackedProvider({ preferEurope: true });
    for (const key of ["model-abliterated", "model-abliterated-large-v2"]) {
      expect(provider.languageModel(key)).toBe(myProvider.languageModel(key));
    }
  });
  it("applies EU fallback and existing request repairs through the registered provider", async () => {
    const originalKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-key";
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        if (String(url).includes("/models?region=eu")) {
          return Response.json({ data: [{ id: "z-ai/glm-5.2" }] });
        }
        if (String(url).startsWith("https://eu.openrouter.ai/")) {
          return Response.json(
            { error: { code: 404, message: "No endpoints found" } },
            { status: 404 },
          );
        }
        return Response.json({
          id: "gen-test",
          model: "z-ai/glm-5.2",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Done" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      });
    try {
      const provider = createTrackedProvider({ preferEurope: true });
      const result = await generateText({
        model: provider.languageModel("model-glm-5.2"),
        prompt: "Test",
        maxRetries: 0,
      });
      expect(result.text).toBe("Done");
      const calls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/chat/completions"),
      );
      expect(calls.map(([url]) => String(url))).toEqual([euUrl, globalUrl]);
      expect(calls[0][1]?.body).toBe(calls[1][1]?.body);
      expect(
        new Headers(calls[1][1]?.headers).get("X-OpenRouter-Metadata"),
      ).toBe("enabled");
      expect(new Headers(calls[1][1]?.headers).get("Authorization")).toBe(
        "Bearer test-key",
      );
    } finally {
      fetchMock.mockRestore();
      if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = originalKey;
    }
  });
});
