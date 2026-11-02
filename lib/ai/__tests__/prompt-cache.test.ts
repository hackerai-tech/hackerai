import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { serialize, deserialize } from "node:v8";
import {
  TextDecoderStream as NodeTextDecoderStream,
  WritableStream as NodeWritableStream,
} from "node:stream/web";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  generateText,
  streamText,
  jsonSchema,
  stepCountIs,
  tool,
  type ModelMessage,
} from "ai";
import {
  buildPromptCacheOptions,
  addPromptCacheBreakpoints,
} from "../prompt-cache";
import { createOpenRouterCacheSessionId } from "../openrouter-cache-session";
import {
  buildProviderOptions,
  buildSystemPrompt,
} from "@/lib/api/chat-stream-helpers";
import { SYSTEM_PROMPT_RUNTIME_BOUNDARY } from "@/lib/system-prompt";
import { myProvider } from "@/lib/ai/providers";

jest.mock("@/lib/db/actions", () => ({ getNotes: jest.fn() }));

const primitives = require("next/dist/compiled/@edge-runtime/primitives/fetch");
const originalResponse = globalThis.Response;
const originalHeaders = globalThis.Headers;
const originalClone = globalThis.structuredClone;
const originalDecoderStream = globalThis.TextDecoderStream;
const originalWritableStream = globalThis.WritableStream;
beforeAll(() => {
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: NodeWritableStream,
  });
  Object.defineProperty(globalThis, "TextDecoderStream", {
    configurable: true,
    value: NodeTextDecoderStream,
  });
  globalThis.structuredClone = <T>(value: T): T =>
    deserialize(serialize(value));
  globalThis.Response = primitives.Response;
  globalThis.Headers = primitives.Headers;
});
afterAll(() => {
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: originalWritableStream,
  });
  Object.defineProperty(globalThis, "TextDecoderStream", {
    configurable: true,
    value: originalDecoderStream,
  });
  globalThis.structuredClone = originalClone;
  globalThis.Response = originalResponse;
  globalThis.Headers = originalHeaders;
});

const slugs = [
  "deepseek/deepseek-v4.1-flash",
  "z-ai/glm-5.3-flash",
  "moonshotai/kimi-k3",
  "x-ai/grok-4.6",
  "anthropic/claude-sonnet-4.6",
  "openai/gpt-5",
  "google/gemini-2.5-pro",
  "abliterated-model",
  "abliterated-model-large-flash",
];

describe("provider cache policy", () => {
  it("bounds rolling markers across parallel tool results and repeated decoration without mutating history", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "inspect",
        providerOptions: { openrouter: { annotations: ["keep"] } },
      },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "private reasoning",
            providerOptions: {
              openrouter: { reasoning_details: [{ signature: "keep" }] },
            },
          },
        ],
      },
      {
        role: "tool",
        content: Array.from({ length: 128 }, (_, i) => ({
          type: "tool-result",
          toolCallId: `call-${i}`,
          toolName: "lookup",
          output: {
            type: "json",
            value: { index: i, cache_control: "user data is preserved" },
          },
          providerOptions: {
            openrouter: { cacheControl: { type: "ephemeral" }, other: "keep" },
          },
        })),
      },
    ];
    const original = JSON.stringify(messages);
    const decorated = addPromptCacheBreakpoints(messages, slugs[4]);
    const count = (input: ModelMessage[]) =>
      JSON.stringify(input).match(/"cacheControl":/g)?.length ?? 0;
    expect(count(decorated)).toBe(2);
    expect(addPromptCacheBreakpoints(decorated, slugs[4])).toEqual(decorated);
    const continued = addPromptCacheBreakpoints(
      [
        ...decorated,
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "next",
              toolName: "lookup",
              output: { type: "text", value: "latest" },
            },
          ],
        },
      ],
      slugs[4],
    );
    expect(count(continued)).toBe(2);
    expect(JSON.stringify(messages)).toBe(original);
    expect(decorated[0].providerOptions?.openrouter.annotations).toEqual([
      "keep",
    ]);
    expect(decorated[1]).toEqual(messages[1]);
    const before = messages[2];
    const after = decorated[2];
    if (before.role !== "tool" || after.role !== "tool")
      throw new Error("fixture");
    expect(
      after.content.map((p) => p.type === "tool-result" && p.output),
    ).toEqual(before.content.map((p) => p.type === "tool-result" && p.output));
    expect(
      after.content.every(
        (p) =>
          "providerOptions" in p &&
          p.providerOptions?.openrouter.other === "keep",
      ),
    ).toBe(true);
    expect(addPromptCacheBreakpoints(messages, slugs[0])).toBe(messages);
  });

  it("does not mark assistant reasoning, approval-only results, or invent messages", () => {
    expect(addPromptCacheBreakpoints([], slugs[4])).toEqual([]);
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "reasoning", text: "reason" }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-approval-response",
            approvalId: "approval",
            approved: true,
          },
        ],
      },
    ];
    expect(addPromptCacheBreakpoints(messages, slugs[4])).toEqual(messages);
  });
  it.each(slugs)("uses the correct namespace for %s", (slug) => {
    const options = buildPromptCacheOptions(slug, "opaque-session");
    if (slug.startsWith("abliterated-")) {
      expect(options).toEqual({
        abliteration: { prompt_cache_key: "opaque-session" },
      });
    } else {
      expect(options).toEqual({
        openrouter: {
          session_id: "opaque-session",
        },
      });
    }
  });

  it("keeps affinity absent without a conversation and avoids paid TTL overrides", () => {
    expect(buildPromptCacheOptions("abliterated-model")).toEqual({});
    expect(buildPromptCacheOptions("z-ai/glm-5.3")).toEqual({ openrouter: {} });
    expect(buildPromptCacheOptions("anthropic/claude-sonnet-4.6")).toEqual({
      openrouter: {},
    });
  });

  it("preserves actual model routing, reasoning and privacy options", () => {
    for (const route of [
      "model-glm-5.3-flash",
      "model-kimi-k3",
      "model-opus-4.6",
      "model-grok-4.6",
    ]) {
      const without = buildProviderOptions(true, "user", route, "agent");
      const withCache = buildProviderOptions(true, "user", route, "agent", {
        cacheSessionId: "opaque-session",
      });
      expect(withCache).toEqual({
        openrouter: { ...without.openrouter, session_id: "opaque-session" },
      });
      expect(withCache.openrouter).not.toHaveProperty("cache_control");
    }
  });

  it("keeps unsupported affinity absent on the direct Inference route", () => {
    expect(
      buildPromptCacheOptions(
        myProvider.languageModel("model-inference-cyber").modelId,
        "opaque-session",
      ),
    ).toEqual({});
    expect(
      buildProviderOptions(true, "user", "model-inference-cyber", "agent", {
        requestedModelSlug: "deepseek-v4.1-flash-1017-cyber",
        selectedModelOverride: "hackerai-max",
        cacheSessionId: "opaque-session",
      }),
    ).toEqual({ inference: { reasoningEffort: "max" } });
  });

  it("keys resumed children separately from parents, siblings, and promoted models", () => {
    const key = (chatId: string, mode: string, requestedModelSlug = slugs[0]) =>
      createOpenRouterCacheSessionId({ chatId, mode, requestedModelSlug });
    expect(key("child", "subagent")).toBe(key("child", "subagent"));
    expect(
      new Set([
        key("child", "subagent"),
        key("sibling", "subagent"),
        key("child", "agent"),
        key("child", "subagent", slugs[1]),
      ]).size,
    ).toBe(4);
  });

  it("uses actual registry model IDs for direct calls and persisted compatibility aliases", () => {
    for (const name of ["model-abliterated", "model-abliterated-large-v2"]) {
      const model = myProvider.languageModel(name);
      expect(model.provider).toBe("abliteration.chat");
      expect(buildPromptCacheOptions(model.modelId, "opaque-session")).toEqual({
        abliteration: { prompt_cache_key: "opaque-session" },
      });
    }
    expect(
      buildPromptCacheOptions(
        myProvider.languageModel("model-opus-4.6").modelId,
        "opaque-session",
      ),
    ).toEqual({
      openrouter: { session_id: "opaque-session" },
    });
  });
});

it.each(
  slugs.flatMap((slug) =>
    [false, true].map((streaming) => ({ slug, streaming })),
  ),
)(
  "serializes cache hints and completes a real SDK tool loop for $slug (streaming=$streaming)",
  async ({ slug, streaming }) => {
    const requests: Record<string, any>[] = [];
    const execute = jest.fn(async ({ value }: { value: string }) => ({
      value,
    }));
    const fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      const hasResult = body.messages.some((m: any) => m.role === "tool");
      if (body.stream) {
        return new Response(
          `data: ${JSON.stringify({
            id: "synthetic-response",
            model: slug,
            created: 1,
            choices: [
              {
                index: 0,
                delta: hasResult
                  ? { content: "CACHE_OK" }
                  : {
                      tool_calls: [
                        {
                          index: 0,
                          id: "lookup-1",
                          type: "function",
                          function: {
                            name: "lookup",
                            arguments: '{"value":"CACHE_OK"}',
                          },
                        },
                      ],
                    },
                finish_reason: hasResult ? "stop" : "tool_calls",
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 10,
              total_tokens: 110,
              prompt_tokens_details: { cached_tokens: hasResult ? 80 : 0 },
            },
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response(
        JSON.stringify({
          id: "synthetic-response",
          model: slug,
          created: 1,
          choices: [
            {
              index: 0,
              finish_reason: hasResult ? "stop" : "tool_calls",
              message: hasResult
                ? { role: "assistant", content: "CACHE_OK" }
                : {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "lookup-1",
                        type: "function",
                        function: {
                          name: "lookup",
                          arguments: '{"value":"CACHE_OK"}',
                        },
                      },
                    ],
                  },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 10,
            total_tokens: 110,
            prompt_tokens_details: { cached_tokens: hasResult ? 80 : 0 },
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });
    const model = slug.startsWith("abliterated-")
      ? createOpenAICompatible({
          name: "abliteration",
          baseURL: "https://example.test/v1",
          apiKey: "test",
          fetch,
        })(slug)
      : createOpenRouter({ apiKey: "test", fetch })(slug);
    const key = createOpenRouterCacheSessionId({
      chatId: "private-chat",
      mode: "agent",
      requestedModelSlug: slug,
    });
    const options = {
      model,
      system: buildSystemPrompt(
        `Preserve instructions.${SYSTEM_PROMPT_RUNTIME_BOUNDARY}Current permissions.`,
        slug,
      ),
      prompt: "Look up CACHE_OK.",
      providerOptions: buildPromptCacheOptions(slug, key),
      prepareStep: ({ messages }: { messages: ModelMessage[] }) => ({
        messages: addPromptCacheBreakpoints(messages, slug),
      }),
      tools: {
        lookup: tool({
          inputSchema: jsonSchema<{ value: string }>({
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          }),
          execute,
        }),
      },
      stopWhen: stepCountIs(3),
      maxRetries: 0,
    };
    const result = streaming
      ? streamText(options)
      : await generateText(options);
    expect(await result.text).toBe("CACHE_OK");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(
      (await result.steps)[1].usage.inputTokenDetails.cacheReadTokens,
    ).toBe(80);
    for (const request of requests) {
      expect(request.model).toBe(slug);
      expect(
        request[
          slug.startsWith("abliterated-") ? "prompt_cache_key" : "session_id"
        ],
      ).toBe(key);
      expect(request).not.toHaveProperty(
        slug.startsWith("abliterated-") ? "session_id" : "prompt_cache_key",
      );
      expect(request).not.toHaveProperty("cache_control");
      const markerCount =
        JSON.stringify(request).match(/"cache_control":/g)?.length ?? 0;
      expect(markerCount).toBeLessThanOrEqual(4);
      if (slug.startsWith("anthropic/")) {
        expect(markerCount).toBe(request === requests[0] ? 3 : 4);
      }
    }
    expect(requests[1].messages.slice(0, requests[0].messages.length)).toEqual(
      requests[0].messages,
    );
    expect(requests[1].tools).toEqual(requests[0].tools);
    expect(requests[1].messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "lookup-1",
      content: '{"value":"CACHE_OK"}',
    });
    expect(requests[1].messages.at(-1).cache_control).toEqual(
      slug.startsWith("anthropic/") ? { type: "ephemeral" } : undefined,
    );
  },
);
