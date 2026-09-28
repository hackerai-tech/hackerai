import { describe, expect, it, jest } from "@jest/globals";
import { generateText, NoSuchModelError } from "ai";
import { createOrcaRouterProvider } from "@/lib/ai/orcarouter/provider";
import { createTrackedProvider, myProvider } from "@/lib/ai/providers";

const edge = require("next/dist/compiled/@edge-runtime/primitives/fetch") as {
  Headers: typeof Headers;
  Response: typeof Response;
};
const originalHeaders = globalThis.Headers;
const originalResponse = globalThis.Response;

beforeAll(() => {
  globalThis.Headers = edge.Headers;
  globalThis.Response = edge.Response;
  // jsdom omits structuredClone, which the AI SDK uses for response parsing.
  const v8 = require("node:v8") as typeof import("node:v8");
  globalThis.structuredClone ??= (value: unknown) =>
    v8.deserialize(v8.serialize(value));
});

afterAll(() => {
  globalThis.Headers = originalHeaders;
  globalThis.Response = originalResponse;
});

const completion = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 0,
  model: "openai/gpt-5.5",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "pong" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

describe("createOrcaRouterProvider", () => {
  it("sends chat requests to the API origin with the user's key", async () => {
    const fetchImpl = jest.fn(
      async (_input: unknown, _init?: RequestInit) =>
        new edge.Response(JSON.stringify(completion), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const provider = createOrcaRouterProvider({
      apiKey: "sk-orca-user",
      apiBaseUrl: "https://api.orcarouter.ai/v1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await generateText({
      model: provider.languageModel("orcarouter:openai/gpt-5.5"),
      prompt: "ping",
    });

    expect(result.text).toBe("pong");
    const [input, init] = fetchImpl.mock.calls[0];
    expect(String(input)).toBe("https://api.orcarouter.ai/v1/chat/completions");
    expect(new edge.Headers(init?.headers).get("authorization")).toBe(
      "Bearer sk-orca-user",
    );
    expect(JSON.parse(String(init?.body)).model).toBe("openai/gpt-5.5");
  });

  it("reports a relay 401 once and never retries with a refresh", async () => {
    const onUnauthorized = jest.fn();
    const fetchImpl = jest.fn(
      async () =>
        new edge.Response(
          JSON.stringify({ error: { message: "invalid api key" } }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
    );
    const provider = createOrcaRouterProvider({
      apiKey: "sk-orca-revoked",
      apiBaseUrl: "https://api.orcarouter.ai/v1",
      onUnauthorized,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const model = provider.languageModel("orcarouter:openai/gpt-5.5");

    await expect(
      generateText({ model, prompt: "ping", maxRetries: 0 }),
    ).rejects.toThrow();
    await expect(
      generateText({ model, prompt: "ping", maxRetries: 0 }),
    ).rejects.toThrow();

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(
      fetchImpl.mock.calls.every(([input]) =>
        String(input).endsWith("/chat/completions"),
      ),
    ).toBe(true);
  });

  it("resolves only orcarouter-prefixed keys", () => {
    const provider = createOrcaRouterProvider({
      apiKey: "k",
      apiBaseUrl: "https://api.orcarouter.ai/v1",
    });
    expect(() => provider.languageModel("model-glm-5.3")).toThrow(
      NoSuchModelError,
    );
  });

  it("adds OrcaRouter models without changing HackerAI routes", () => {
    const provider = createTrackedProvider(
      createOrcaRouterProvider({
        apiKey: "k",
        apiBaseUrl: "https://api.orcarouter.ai/v1",
      }),
    );
    expect(provider.languageModel("model-glm-5.3").modelId).toBe(
      myProvider.languageModel("model-glm-5.3").modelId,
    );
    expect(
      provider.languageModel("orcarouter:google/gemini-3.5-flash").modelId,
    ).toBe("google/gemini-3.5-flash");
    expect(() =>
      createTrackedProvider().languageModel("orcarouter:a/b"),
    ).toThrow(NoSuchModelError);
  });
});
