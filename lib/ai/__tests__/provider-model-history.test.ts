import {
  APICallError,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
} from "ai";
import { WritableStream } from "node:stream/web";
import { z } from "zod";
import { createWideEventBuilder } from "@/lib/logger";
import {
  withProviderModelHistory,
  type ProviderModelHistoryEntry,
} from "../provider-model-history";

const originalWritableStream = globalThis.WritableStream;
beforeAll(() => {
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: WritableStream,
  });
});
afterAll(() => {
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: originalWritableStream,
  });
});

const finish = (reason = "stop", providerMetadata = {}) => ({
  type: "finish",
  finishReason: { unified: reason, raw: reason },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  providerMetadata,
});
const makeModel = (
  provider: string,
  modelId: string,
  doStream: jest.Mock,
): LanguageModel => ({
  specificationVersion: "v3",
  provider,
  modelId,
  supportedUrls: {},
  doGenerate: jest.fn(),
  doStream,
});
const response = (parts: unknown[], headers = {}) => ({
  response: { headers },
  stream: new ReadableStream({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part));
      controller.close();
    },
  }),
});
const open = (model: LanguageModel, abortSignal?: AbortSignal) => {
  if (typeof model === "string") throw new Error("Expected model object");
  return model.doStream({ prompt: [], abortSignal });
};
const consume = async (model: LanguageModel) => {
  const reader = (await open(model)).stream.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
};

it("keeps the first Abliteration call and the reported continuation model/provider in a real SDK tool loop", async () => {
  const builder = createWideEventBuilder("chat", "/api/agent").setModel(
    "model-abliterated",
  );
  const observe = (model: LanguageModel, configured: string, step: number) =>
    withProviderModelHistory(model, {
      configured,
      generationStep: step,
      onStart: (entry) => builder.recordProviderModelCall(entry),
    });
  const first = observe(
    makeModel(
      "abliteration.chat",
      "abliterated-model",
      jest.fn(async () =>
        response(
          [
            {
              type: "response-metadata",
              modelId: "abliterated-model",
              id: "ab-id",
            },
            {
              type: "tool-call",
              toolCallId: "once",
              toolName: "lookup",
              input: "{}",
            },
            finish("tool-calls"),
          ],
          { "x-request-id": "direct-provider-request" },
        ),
      ),
    ),
    "model-abliterated",
    1,
  );
  const last = observe(
    makeModel(
      "openrouter",
      "deepseek/requested",
      jest.fn(async () =>
        response(
          [
            {
              type: "response-metadata",
              modelId: "deepseek/served-fallback",
              id: "gen-last",
            },
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: "Finished" },
            { type: "text-end", id: "answer" },
            finish("stop", {
              openrouter: {
                provider: "DeepInfra",
                attempts: [
                  {
                    provider: "First upstream",
                    model: "deepseek/requested",
                    status: 503,
                  },
                  {
                    provider: "DeepInfra",
                    model: "deepseek/served-fallback",
                    status: 200,
                    selected: true,
                  },
                ],
                private_payload: "do not log this",
              },
            }),
          ],
          {
            "x-request-id": "router-request",
            authorization: "do not log this",
          },
        ),
      ),
    ),
    "model-baseline",
    2,
  );
  const result = streamText({
    model: first,
    prompt: "Private prompt must not appear in history",
    tools: {
      lookup: tool({ inputSchema: z.object({}), execute: async () => "ok" }),
    },
    stopWhen: stepCountIs(2),
    prepareStep: ({ stepNumber }) => ({
      model: stepNumber === 0 ? first : last,
    }),
    maxRetries: 0,
  });
  await result.consumeStream();
  expect(await result.text).toBe("Finished");
  const history = builder.build().model?.history;
  expect(history).toEqual([
    expect.objectContaining({
      call_index: 1,
      generation_step: 1,
      configured: "model-abliterated",
      requested: "abliterated-model",
      actual: "abliterated-model",
      provider: "abliteration.chat",
      response_id: "ab-id",
      outcome: "completed",
      finish_reason: "tool-calls",
    }),
    expect.objectContaining({
      call_index: 2,
      generation_step: 2,
      configured: "model-baseline",
      requested: "deepseek/requested",
      actual: "deepseek/served-fallback",
      provider: "openrouter",
      upstream_provider: "DeepInfra",
      response_id: "gen-last",
      openrouter_generation_id: "gen-last",
      openrouter_request_id: "router-request",
      outcome: "completed",
      finish_reason: "stop",
      openrouter_attempts: expect.any(Array),
    }),
  ]);
  expect(history?.[0].openrouter_request_id).toBeUndefined();
  expect(JSON.stringify(history)).not.toMatch(
    /Private prompt|do not log this|Finished/,
  );
});

it("records failed attempts before the successful retry without guessing a response model", async () => {
  const entries: ProviderModelHistoryEntry[] = [];
  const failure = new APICallError({
    message: "private provider error",
    url: "https://provider.example",
    requestBodyValues: {},
    statusCode: 503,
    isRetryable: true,
  });
  const doStream = jest
    .fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(response([finish()]));
  const model = withProviderModelHistory(
    makeModel("abliteration.chat", "requested", doStream),
    {
      configured: "configured",
      generationStep: 1,
      onStart: (entry) => entries.push(entry),
    },
  );
  const result = streamText({ model, prompt: "private prompt", maxRetries: 1 });
  await result.consumeStream();
  expect(doStream).toHaveBeenCalledTimes(2);
  expect(
    entries.map(({ outcome, actual, generation_step }) => ({
      outcome,
      actual,
      generation_step,
    })),
  ).toEqual([
    { outcome: "error", actual: undefined, generation_step: 1 },
    { outcome: "completed", actual: undefined, generation_step: 1 },
  ]);
  expect(JSON.stringify(entries)).not.toContain("private provider error");
});

it.each(["error_part", "read_error", "incomplete"] as const)(
  "preserves stream behavior and logs %s",
  async (scenario) => {
    const entries: ProviderModelHistoryEntry[] = [];
    const error = new Error("private");
    const parts = [{ type: "error", error }, finish()];
    const doStream = jest.fn(async () =>
      scenario === "read_error"
        ? {
            stream: new ReadableStream({
              start(controller) {
                controller.error(error);
              },
            }),
          }
        : response(scenario === "error_part" ? parts : []),
    );
    const model = withProviderModelHistory(
      makeModel("provider", "requested", doStream),
      {
        configured: "configured",
        generationStep: 3,
        onStart: (entry) => entries.push(entry),
      },
    );
    if (scenario === "read_error")
      await expect(consume(model)).rejects.toBe(error);
    else
      expect(await consume(model)).toEqual(
        scenario === "error_part" ? parts : [],
      );
    expect(entries[0].outcome).toBe(
      scenario === "incomplete" ? "incomplete" : "error",
    );
  },
);

it("captures cancellation, forwards it to the provider and removes the abort listener", async () => {
  const entries: ProviderModelHistoryEntry[] = [];
  const controller = new AbortController();
  const remove = jest.spyOn(controller.signal, "removeEventListener");
  const cancel = jest.fn();
  const model = withProviderModelHistory(
    makeModel(
      "provider",
      "requested",
      jest.fn(async () => ({
        stream: new ReadableStream({ cancel }),
      })),
    ),
    {
      configured: "configured",
      generationStep: 1,
      onStart: (entry) => entries.push(entry),
    },
  );
  const result = await open(model, controller.signal);
  await result.stream.cancel("stop");
  expect(cancel).toHaveBeenCalledWith("stop");
  expect(entries[0].outcome).toBe("aborted");
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
});

it("logs an abort while waiting for headers, even if the provider never settles", async () => {
  const entries: ProviderModelHistoryEntry[] = [];
  const controller = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const model = withProviderModelHistory(
    makeModel(
      "provider",
      "requested",
      jest.fn(() => {
        markStarted();
        return new Promise(() => {});
      }),
    ),
    {
      configured: "configured",
      generationStep: 1,
      onStart: (entry) => entries.push(entry),
    },
  );
  void open(model, controller.signal);
  await started;
  controller.abort();
  expect(entries[0].outcome).toBe("aborted");
  expect(entries[0].duration_ms).toEqual(expect.any(Number));
});

it("does not interrupt a provider when the history logger fails", async () => {
  const parts = [finish()];
  const model = withProviderModelHistory(
    makeModel(
      "provider",
      "requested",
      jest.fn(async () => response(parts)),
    ),
    {
      configured: "configured",
      generationStep: 1,
      onStart: () => {
        throw new Error("logger offline");
      },
    },
  );
  expect(await consume(model)).toEqual(parts);
});
