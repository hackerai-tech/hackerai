import { createAbliterationMediaRecovery } from "../abliteration-media-recovery";
import { WritableStream as NodeWritableStream } from "node:stream/web";
import {
  createUIMessageStream,
  streamText,
  type ModelMessage,
  type UIMessageChunk,
} from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRecoverableProviderErrorFilter } from "../provider-error-stream";
import {
  PLATFORM_AUTHORIZATION_ANNOTATION,
  preparePlatformAuthorizationForModel,
} from "../platform-authorization";

jest.mock("server-only", () => ({}));

const originalWritableStream = globalThis.WritableStream;
beforeAll(() => {
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: NodeWritableStream,
  });
});
afterAll(() => {
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: originalWritableStream,
  });
});

type StreamPart =
  Awaited<
    ReturnType<MockLanguageModelV3["doStream"]>
  >["stream"] extends ReadableStream<infer T>
    ? T
    : never;
const response = (parts: StreamPart[]) => ({
  stream: new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  }),
});
const successfulParts: StreamPart[] = [
  { type: "text-start", id: "answer" },
  { type: "text-delta", id: "answer", delta: "Fallback answer" },
  { type: "text-end", id: "answer" },
  {
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 3, text: 3, reasoning: 0 },
    },
  },
];

async function runRecovery(
  primary: MockLanguageModelV3,
  fallbackFails = false,
) {
  const userMessages: ModelMessage[] = [
    { role: "user", content: "Inspect my test application" },
  ];
  const original = JSON.stringify(userMessages);
  const fallbackError = new Error("OpenRouter unavailable");
  const fallback = new MockLanguageModelV3({
    modelId: "openrouter-baseline",
    doStream: async () => {
      if (fallbackFails) throw fallbackError;
      return response(successfulParts);
    },
  });
  let primaryError: unknown;
  let retried = false;
  const output = createUIMessageStream({
    execute: ({ writer }) => {
      const result = streamText({
        model: createAbliterationMediaRecovery(
          async (messages) => messages,
          new AbortController().signal,
        )(primary),
        maxRetries: 0,
        messages: preparePlatformAuthorizationForModel(
          userMessages,
          true,
          "model-abliterated",
        ),
        onError: ({ error }) => {
          primaryError = error;
        },
      });
      writer.merge(
        result
          .toUIMessageStream({
            onFinish: ({ isAborted }) => {
              expect(isAborted).toBe(false);
              if (!primaryError) return;
              retried = true;
              const retry = streamText({
                model: fallback,
                maxRetries: 0,
                messages: preparePlatformAuthorizationForModel(
                  userMessages,
                  true,
                  "model-grok-4.6",
                ),
                onError: () => {},
              });
              writer.merge(
                retry.toUIMessageStream({
                  onError: () => fallbackError.message,
                }),
              );
            },
          })
          .pipeThrough(createRecoverableProviderErrorFilter(() => !retried)),
      );
    },
  });
  const chunks: UIMessageChunk[] = [];
  const reader = output.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  expect(JSON.stringify(userMessages)).toBe(original);
  expect(JSON.stringify(primary.doStreamCalls[0].prompt)).not.toContain(
    PLATFORM_AUTHORIZATION_ANNOTATION,
  );
  if (retried)
    expect(JSON.stringify(fallback.doStreamCalls[0].prompt)).toContain(
      PLATFORM_AUTHORIZATION_ANNOTATION,
    );
  return { chunks, fallback, primaryError };
}

it.each([400, 401, 402, 403, 404, 413, 415, 429, 500, 503])(
  "hides HTTP %s and streams the baseline answer with legacy authorization",
  async (statusCode) => {
    const error = Object.assign(
      new Error("Abliteration insufficient balance / provider error"),
      { statusCode },
    );
    const primary = new MockLanguageModelV3({
      modelId: "abliterated-model",
      doStream: async () => {
        throw error;
      },
    });
    const { chunks, fallback, primaryError } = await runRecovery(primary);
    expect(primaryError).toBe(error);
    expect(fallback.doStreamCalls).toHaveLength(1);
    expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
    expect(chunks).toContainEqual({
      type: "text-delta",
      id: "answer",
      delta: "Fallback answer",
    });
  },
);

it.each(["in-band", "socket"])(
  "recovers a %s failure after partial text without exposing an error",
  async (kind) => {
    const error = new Error("Provider stream failed");
    const primary = new MockLanguageModelV3({
      modelId: "abliterated-model",
      doStream: async () => {
        const parts: StreamPart[] = [
          { type: "text-start", id: "partial" },
          { type: "text-delta", id: "partial", delta: "Partial answer" },
        ];
        if (kind === "in-band")
          return response([...parts, { type: "error", error }]);
        return {
          stream: new ReadableStream<StreamPart>({
            pull(controller) {
              const part = parts.shift();
              if (part) controller.enqueue(part);
              else controller.error(error);
            },
          }),
        };
      },
    });
    const { chunks, fallback } = await runRecovery(primary);
    expect(fallback.doStreamCalls).toHaveLength(1);
    expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
    expect(
      chunks.some(
        (chunk) =>
          chunk.type === "text-delta" && chunk.delta === "Fallback answer",
      ),
    ).toBe(true);
  },
);

it("does not hide an OpenRouter failure or retry it again", async () => {
  const primary = new MockLanguageModelV3({
    modelId: "abliterated-model",
    doStream: async () => {
      throw new Error("No balance");
    },
  });
  const { chunks, fallback } = await runRecovery(primary, true);
  expect(fallback.doStreamCalls).toHaveLength(1);
  expect(chunks.filter((chunk) => chunk.type === "error")).toEqual([
    { type: "error", errorText: "OpenRouter unavailable" },
  ]);
});

it("leaves successful treatment streaming unchanged", async () => {
  const primary = new MockLanguageModelV3({
    modelId: "abliterated-model",
    doStream: async () => response(successfulParts),
  });
  const { chunks, fallback } = await runRecovery(primary);
  expect(fallback.doStreamCalls).toHaveLength(0);
  expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
});
