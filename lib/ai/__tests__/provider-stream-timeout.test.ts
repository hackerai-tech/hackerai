import { stepCountIs, streamText, tool, type LanguageModel } from "ai";
import { WritableStream } from "node:stream/web";
import { z } from "zod";
import { withProviderStreamTimeout } from "../provider-stream-timeout";
import { isRetriableProviderStreamDisconnectError } from "@/lib/utils/error-utils";

const makeModel = (doStream: jest.Mock): LanguageModel => ({
  specificationVersion: "v3",
  provider: "test",
  modelId: "test-model",
  supportedUrls: {},
  doStream,
  doGenerate: jest.fn(),
});
const open = async (model: LanguageModel, abortSignal?: AbortSignal) => {
  if (typeof model === "string") throw new Error("Expected model object");
  return model.doStream({ prompt: [], abortSignal });
};
const finish = (reason = "stop") => ({
  type: "finish",
  finishReason: { unified: reason, raw: reason },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
});

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
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it("bounds a request that never resolves, aborts upstream, and cleans up a late response", async () => {
  let resolve!: (value: unknown) => void;
  let signal!: AbortSignal;
  const onTimeout = jest.fn();
  const doStream = jest.fn((params) => {
    signal = params.abortSignal;
    return new Promise((r) => {
      resolve = r;
    });
  });
  const pending = open(
    withProviderStreamTimeout(makeModel(doStream), {
      timeoutMs: 1000,
      onTimeout,
    }),
  );
  const rejected = expect(pending).rejects.toThrow(
    "Provider response timed out",
  );
  await jest.advanceTimersByTimeAsync(1000);
  await rejected;
  expect(signal.aborted).toBe(true);
  expect(onTimeout).toHaveBeenCalledWith({
    phase: "response",
    timeoutMs: 1000,
    modelId: "test-model",
  });
  const cancel = jest.fn();
  resolve({ stream: new ReadableStream({ cancel }) });
  await jest.advanceTimersByTimeAsync(0);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

it("resets the deadline after each chunk and emits a recoverable error without aborting the run", async () => {
  let source!: ReadableStreamDefaultController;
  const cancel = jest.fn(() => new Promise<void>(() => {}));
  const onTimeout = jest.fn(() => {
    throw new Error("logger offline");
  });
  const run = new AbortController();
  const response = await open(
    withProviderStreamTimeout(
      makeModel(
        jest.fn(async () => ({
          stream: new ReadableStream({
            start(c) {
              source = c;
            },
            cancel,
          }),
        })),
      ),
      { timeoutMs: 1000, onTimeout },
    ),
    run.signal,
  );
  const reader = response.stream.getReader();
  for (let index = 0; index < 3; index++) {
    const next = reader.read();
    await jest.advanceTimersByTimeAsync(900);
    source.enqueue({ type: "text-delta", id: "text", delta: "a" });
    expect((await next).done).toBe(false);
  }
  const failed = reader.read();
  await jest.advanceTimersByTimeAsync(1000);
  const part = (await failed).value;
  expect(part.type).toBe("error");
  const error = part.error;
  expect(isRetriableProviderStreamDisconnectError(error)).toBe(true);
  expect(run.signal.aborted).toBe(false);
  expect(onTimeout).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

it("does not time downstream pauses, and disposes timers when canceled", async () => {
  const cancel = jest.fn();
  const onTimeout = jest.fn();
  const response = await open(
    withProviderStreamTimeout(
      makeModel(
        jest.fn(async () => ({
          stream: new ReadableStream({ cancel }),
        })),
      ),
      { timeoutMs: 1000, onTimeout },
    ),
  );
  await jest.advanceTimersByTimeAsync(10000);
  expect(onTimeout).not.toHaveBeenCalled();
  const reader = response.stream.getReader();
  const pending = reader.read();
  await jest.advanceTimersByTimeAsync(100);
  await reader.cancel();
  await pending;
  await jest.advanceTimersByTimeAsync(2000);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(onTimeout).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it.each(["before_request", "during_request", "during_chunk"])(
  "preserves user cancellation %s without timeout telemetry",
  async (phase) => {
    const run = new AbortController();
    const reason = new DOMException("Stopped by user", "AbortError");
    const onTimeout = jest.fn();
    const doStream = jest.fn(() =>
      phase === "during_request"
        ? new Promise(() => {})
        : Promise.resolve({ stream: new ReadableStream() }),
    );
    const model = withProviderStreamTimeout(makeModel(doStream), {
      timeoutMs: 1000,
      onTimeout,
    });
    if (phase === "before_request") run.abort(reason);
    const response = open(model, run.signal);
    const pending =
      phase === "during_chunk"
        ? (await response).stream.getReader().read()
        : response;
    const rejected = expect(pending).rejects.toBe(reason);
    await jest.advanceTimersByTimeAsync(0);
    run.abort(reason);
    await rejected;
    await jest.advanceTimersByTimeAsync(2000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    if (phase === "before_request") expect(doStream).not.toHaveBeenCalled();
  },
);

it("lets a real SDK tool wait longer than the provider timeout and complete the next step", async () => {
  const execute = jest.fn(
    () =>
      new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 5000)),
  );
  const doStream = jest.fn(async () => ({
    stream: new ReadableStream({
      start(output) {
        if (doStream.mock.calls.length === 1) {
          output.enqueue({
            type: "tool-call",
            toolCallId: "once",
            toolName: "wait",
            input: "{}",
          });
          output.enqueue(finish("tool-calls"));
        } else {
          output.enqueue({ type: "text-start", id: "done" });
          output.enqueue({ type: "text-delta", id: "done", delta: "Finished" });
          output.enqueue({ type: "text-end", id: "done" });
          output.enqueue(finish());
        }
        output.close();
      },
    }),
  }));
  const onTimeout = jest.fn();
  const onError = jest.fn();
  const result = streamText({
    model: withProviderStreamTimeout(makeModel(doStream), {
      timeoutMs: 1000,
      onTimeout,
    }),
    prompt: "Wait, then report",
    tools: { wait: tool({ inputSchema: z.object({}), execute }) },
    stopWhen: stepCountIs(3),
    maxRetries: 0,
    onError,
  });
  const completed = result.consumeStream();
  await jest.advanceTimersByTimeAsync(6000);
  await completed;
  expect(await result.text).toBe("Finished");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(onTimeout).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it("reports a stalled initial request through the SDK error callback rather than user cancellation", async () => {
  const onError = jest.fn();
  const onAbort = jest.fn();
  const doStream = jest.fn(() => new Promise(() => {}));
  const result = streamText({
    model: withProviderStreamTimeout(makeModel(doStream), { timeoutMs: 1000 }),
    prompt: "Respond",
    maxRetries: 0,
    onError,
    onAbort,
  });
  const completed = result.consumeStream();
  await jest.advanceTimersByTimeAsync(1100);
  await completed;
  expect(onError).toHaveBeenCalledTimes(1);
  expect(
    isRetriableProviderStreamDisconnectError(onError.mock.calls[0][0].error),
  ).toBe(true);
  expect(onAbort).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});
