import {
  readUIMessageStream,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { WritableStream } from "node:stream/web";
import { deserialize, serialize } from "node:v8";
import { z } from "zod";
import { fetchWithErrorHandlers } from "@/lib/utils";
import { isRetriableProviderStreamDisconnectError } from "@/lib/utils/error-utils";
import { resumeAgentLongStream } from "../agent-long-transport";
import { createAgentUiMessageStream } from "../agent-ui-message-stream";
import { createProviderErrorDeferral } from "../provider-error-stream";
import { formatToolStreamError } from "../tool-stream-error";
import {
  readTriggerRunStream,
  retrieveTriggerRunStatus,
} from "../trigger-browser-realtime";

jest.mock("server-only", () => ({}));
jest.mock("@/lib/utils", () => ({
  ...jest.requireActual("@/lib/utils"),
  fetchWithErrorHandlers: jest.fn(),
}));
jest.mock("../trigger-browser-realtime", () => ({
  readTriggerRunStream: jest.fn(),
  retrieveTriggerRunStatus: jest.fn(),
}));

const { Response: FetchResponse } = jest.requireActual(
  "next/dist/compiled/@edge-runtime/primitives/fetch",
);
const descriptors = ["Response", "structuredClone", "WritableStream"].map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
beforeAll(() => {
  Object.defineProperty(globalThis, "Response", {
    configurable: true,
    value: FetchResponse,
  });
  Object.defineProperty(globalThis, "structuredClone", {
    configurable: true,
    value: (value: unknown) => deserialize(serialize(value)),
  });
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: WritableStream,
  });
});
afterAll(() => {
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
afterEach(() => {
  jest.useRealTimers();
  jest.resetAllMocks();
});

type StreamPart =
  Awaited<
    ReturnType<MockLanguageModelV3["doStream"]>
  >["stream"] extends ReadableStream<infer T>
    ? T
    : never;

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
};
const finish = (unified: "stop" | "tool-calls"): StreamPart => ({
  type: "finish",
  finishReason: { unified, raw: unified },
  usage,
});
const answer = (text: string): StreamPart[] => [
  { type: "text-start", id: "answer" },
  { type: "text-delta", id: "answer", delta: text },
  { type: "text-end", id: "answer" },
  finish("stop"),
];
// Matches the existing replay-safe disconnect classification.
const disconnect = (): StreamPart[] => [
  { type: "error", error: new Error("terminated") },
];
const partialThenDisconnect = (text: string): StreamPart[] => [
  { type: "text-start", id: "partial" },
  { type: "text-delta", id: "partial", delta: text },
  { type: "error", error: new Error("terminated") },
];
const response = (parts: StreamPart[]) => ({
  stream: new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  }),
});

/**
 * Publish attempts the way Agent and Ask do: each attempt's UI stream goes
 * through the shared provider-error boundary, and its onFinish owns the
 * existing retry decision, discarding only after the retry is merged. The
 * decision here is the replay-safe disconnect predicate; retry eligibility
 * itself is covered by the provider-retry suites.
 */
type RunOptions = {
  stopBeforeDecision?: boolean;
  /** Delay each recovery attempt's provider response (fake timers only). */
  retryDelayMs?: number;
  /** Fail the owning onFinish, as a persistence or setup error would. */
  failOnFinish?: boolean;
};

function publishAttempts(attempts: StreamPart[][][], options: RunOptions = {}) {
  const stop = new AbortController();
  const execute = jest.fn(async () => ({ saved: true }));
  const tools = { save: tool({ inputSchema: z.object({}), execute }) };
  const models = attempts.map((steps, index) => {
    let step = 0;
    return new MockLanguageModelV3({
      modelId: `attempt-${index}`,
      doStream: async () => {
        if (index > 0 && options.retryDelayMs)
          await new Promise((resolve) =>
            setTimeout(resolve, options.retryDelayMs),
          );
        return response(steps[step++] ?? []);
      },
    });
  });
  const server = createAgentUiMessageStream({
    abortSignal: stop.signal,
    onError: () => "outer failure",
    execute: ({ writer }) => {
      const start = (index: number) => {
        let providerError: unknown;
        const result = streamText({
          model: models[index],
          prompt: "Save once, then report.",
          tools,
          stopWhen: stepCountIs(3),
          maxRetries: 0,
          onError: ({ error }) => {
            providerError = error;
          },
        });
        const providerErrors = createProviderErrorDeferral();
        writer.merge(
          result
            .toUIMessageStream({
              onError: formatToolStreamError,
              generateMessageId: () => `assistant-${index}`,
              onFinish: ({ isAborted }) => {
                if (options.failOnFinish)
                  throw new Error("controlled onFinish failure");
                if (options.stopBeforeDecision) stop.abort();
                const recover =
                  providerError !== undefined &&
                  !isAborted &&
                  !stop.signal.aborted &&
                  index + 1 < models.length &&
                  isRetriableProviderStreamDisconnectError(providerError);
                if (recover) {
                  start(index + 1);
                  providerErrors.discard();
                } else {
                  providerErrors.release();
                }
              },
            })
            .pipeThrough(providerErrors.filter()),
        );
      };
      start(0);
    },
  });
  return { server, execute };
}

async function drain<T>(stream: ReadableStream<T>) {
  const values: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return values;
    values.push(value);
  }
}

async function* iterate<T>(stream: ReadableStream<T>) {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Server publication, the actual browser transport and the SDK client parser. */
async function run(attempts: StreamPart[][][], options?: RunOptions) {
  const { server, execute } = publishAttempts(attempts, options);
  const [toTransport, toRecord] = server.tee();
  const published = drain(toRecord);
  jest
    .mocked(readTriggerRunStream)
    .mockReturnValue(
      iterate(toTransport) as unknown as ReturnType<
        typeof readTriggerRunStream
      >,
    );
  jest.mocked(retrieveTriggerRunStatus).mockResolvedValue("EXECUTING");
  jest
    .mocked(fetchWithErrorHandlers)
    .mockResolvedValue(
      new Response(
        JSON.stringify({ runId: "owned-run", publicAccessToken: "token" }),
      ),
    );
  const transport = await resumeAgentLongStream(
    "https://qa.invalid/api/agent/resume?chatId=owned-chat",
    undefined,
  );
  const body = transport.text();
  // Under fake timers, advance the transport's own drain/flush timers and the
  // controlled provider delay until both the browser and server sides settle.
  let settled = false;
  void Promise.all([body, published]).finally(() => {
    settled = true;
  });
  for (let step = 0; options?.retryDelayMs && !settled && step < 400; step++)
    await jest.advanceTimersByTimeAsync(50);
  const delivered = (await body)
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.slice(6)) as UIMessageChunk);

  const clientErrors: string[] = [];
  let message: UIMessage | undefined;
  for await (const snapshot of readUIMessageStream({
    stream: new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const chunk of delivered) controller.enqueue(chunk);
        controller.close();
      },
    }),
    onError: (error) => clientErrors.push((error as Error).message),
  }))
    message = snapshot;

  const text = (message?.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("");
  return {
    published: await published,
    delivered,
    clientErrors,
    text,
    execute,
  };
}

const errors = (chunks: UIMessageChunk[]) =>
  chunks.filter((chunk) => chunk.type === "error");
const finishes = (chunks: UIMessageChunk[]) =>
  chunks.filter((chunk) => chunk.type === "finish");
const indexOf = (
  chunks: UIMessageChunk[],
  predicate: (chunk: UIMessageChunk) => boolean,
) => chunks.findIndex(predicate);
const retryStartIndex = (chunks: UIMessageChunk[]) =>
  indexOf(
    chunks,
    (chunk) => chunk.type === "start" && chunk.messageId === "assistant-1",
  );

it("delivers a recovered disconnect without a premature terminal error", async () => {
  const result = await run([
    [
      [
        {
          type: "tool-call",
          toolCallId: "save-1",
          toolName: "save",
          input: "{}",
        },
        finish("tool-calls"),
      ],
      partialThenDisconnect("Partial answer. "),
    ],
    [answer("Recovered answer.")],
  ]);

  // One assertion so a failure shows server, transport and client together.
  expect({
    publishedErrors: errors(result.published),
    deliveredErrors: errors(result.delivered),
    clientErrors: result.clientErrors,
    visibleText: result.text,
  }).toEqual({
    publishedErrors: [],
    deliveredErrors: [],
    clientErrors: [],
    visibleText: "Partial answer. Recovered answer.",
  });
  // Holding and discarding must not repeat earlier output or side effects.
  expect(result.execute).toHaveBeenCalledTimes(1);
  expect(
    result.delivered.filter((chunk) => chunk.type === "tool-output-available"),
  ).toHaveLength(1);
  expect(
    result.published.filter(
      (chunk) =>
        chunk.type === "text-delta" && chunk.delta === "Partial answer. ",
    ),
  ).toHaveLength(1);
  // The recovered attempt keeps its step boundary but not its terminal finish,
  // so the browser never enters its post-finish drain before the retry.
  expect(finishes(result.published)).toHaveLength(1);
  expect(
    result.published
      .slice(0, retryStartIndex(result.published))
      .some((chunk) => chunk.type === "finish-step"),
  ).toBe(true);
  expect(indexOf(result.published, (c) => c.type === "finish")).toBeGreaterThan(
    retryStartIndex(result.published),
  );
});

it("keeps the transport attached while a recovery waits longer than the post-finish drain", async () => {
  jest.useFakeTimers({
    doNotFake: ["nextTick", "queueMicrotask", "setImmediate"],
  });
  const result = await run(
    [[partialThenDisconnect("Partial answer. ")], [answer("Late recovery.")]],
    { retryDelayMs: 3_000 },
  );

  expect({
    deliveredErrors: errors(result.delivered),
    clientErrors: result.clientErrors,
    visibleText: result.text,
    deliveredFinishes: finishes(result.delivered).length,
  }).toEqual({
    deliveredErrors: [],
    clientErrors: [],
    visibleText: "Partial answer. Late recovery.",
    deliveredFinishes: 1,
  });
});

it("publishes a successful attempt's finish unchanged when no recovery runs", async () => {
  const result = await run([[answer("Direct answer.")], [answer("Unused.")]]);

  expect(errors(result.published)).toEqual([]);
  expect(finishes(result.published)).toHaveLength(1);
  expect(result.delivered.at(-1)?.type).toBe("finish");
  expect(result.clientErrors).toEqual([]);
  expect(result.text).toBe("Direct answer.");
});

it("keeps an owning onFinish failure terminal for the browser", async () => {
  const result = await run([[answer("Answer before failure.")]], {
    failOnFinish: true,
  });

  expect(result.delivered.at(-1)).toEqual({
    type: "error",
    errorText: "outer failure",
  });
  expect(result.clientErrors).toEqual(["outer failure"]);
});

it("delivers a recovery that succeeds on the final attempt", async () => {
  const result = await run([
    [disconnect()],
    [disconnect()],
    [answer("Final attempt answer.")],
  ]);

  expect({
    publishedErrors: errors(result.published),
    clientErrors: result.clientErrors,
    visibleText: result.text,
  }).toEqual({
    publishedErrors: [],
    clientErrors: [],
    visibleText: "Final attempt answer.",
  });
});

it("publishes exactly one terminal error when every recovery attempt fails", async () => {
  const result = await run([[disconnect()], [disconnect()], [disconnect()]]);

  expect(errors(result.published)).toEqual([
    { type: "error", errorText: "An error occurred." },
  ]);
  // Only the exhausted attempt keeps its terminal chunks, unchanged and in order.
  expect(
    result.published
      .filter((chunk) => ["error", "finish"].includes(chunk.type))
      .map((chunk) => chunk.type),
  ).toEqual(["error", "finish"]);
  expect(errors(result.delivered)).toEqual([
    { type: "error", errorText: "An error occurred." },
  ]);
  expect(result.delivered.at(-1)).toEqual({
    type: "error",
    errorText: "An error occurred.",
  });
  expect(result.clientErrors).toEqual(["An error occurred."]);
});

it("publishes a provider error immediately terminal when no retry is eligible", async () => {
  const rejected = Object.assign(new Error("Invalid request"), {
    statusCode: 400,
  });
  const result = await run([
    [
      [
        { type: "text-start", id: "partial" },
        { type: "text-delta", id: "partial", delta: "Partial answer." },
        { type: "error", error: rejected },
      ],
    ],
    [answer("Must not run.")],
  ]);

  expect(errors(result.delivered)).toEqual([
    { type: "error", errorText: "An error occurred." },
  ]);
  expect(result.delivered.at(-1)?.type).toBe("error");
  expect(result.clientErrors).toEqual(["An error occurred."]);
  expect(result.text).toBe("Partial answer.");
  expect(
    result.published
      .filter((chunk) =>
        ["error", "finish-step", "finish"].includes(chunk.type),
      )
      .map((chunk) => chunk.type),
  ).toEqual(["error", "finish-step", "finish"]);
  expect(
    result.published.some(
      (chunk) => chunk.type === "start" && chunk.messageId === "assistant-1",
    ),
  ).toBe(false);
});

it("still publishes the error when Stop declines the existing recovery", async () => {
  const result = await run([[disconnect()], [answer("Must not run.")]], {
    stopBeforeDecision: true,
  });

  expect(errors(result.delivered)).toEqual([
    { type: "error", errorText: "An error occurred." },
  ]);
  expect(result.clientErrors).toEqual(["An error occurred."]);
  expect(
    result.published.some(
      (chunk) => chunk.type === "start" && chunk.messageId === "assistant-1",
    ),
  ).toBe(false);
});
