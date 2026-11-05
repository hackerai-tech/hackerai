import { stepCountIs, streamText, tool, type LanguageModel } from "ai";
import { WritableStream } from "node:stream/web";
import { z } from "zod";
import {
  withProviderStreamTimeout,
  isProviderResponseTimeout,
} from "../provider-stream-timeout";
import { isRetriableProviderStreamDisconnectError } from "@/lib/utils/error-utils";
import { getSubagentProviderRetryDecision } from "@/lib/ai/subagents/runtime-recovery";

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

it.each([
  { timeoutMs: 1000, totalTimeoutMs: undefined, phase: "response" },
  { timeoutMs: 2000, totalTimeoutMs: 1000, phase: "total" },
])(
  "bounds a pending request by $phase and cleans up a late response",
  async (options) => {
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
        timeoutMs: options.timeoutMs,
        totalTimeoutMs: options.totalTimeoutMs,
        onTimeout,
      }),
    );
    const rejected = expect(pending).rejects.toThrow(
      `Provider ${options.phase} timed out`,
    );
    await jest.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(signal.aborted).toBe(true);
    await expect(pending.catch(isProviderResponseTimeout)).resolves.toBe(true);
    expect(onTimeout).toHaveBeenCalledWith({
      phase: options.phase,
      timeoutMs: 1000,
      modelId: "test-model",
    });
    const cancel = jest.fn();
    resolve({ stream: new ReadableStream({ cancel }) });
    await jest.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  },
);

it.each(["text-delta", "reasoning-delta", "raw"])(
  "bounds accumulated provider time despite repeated %s chunks",
  async (type) => {
    let source!: ReadableStreamDefaultController;
    const cancel = jest.fn(() => new Promise<void>(() => {}));
    const onTimeout = jest.fn();
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
        { timeoutMs: 1000, totalTimeoutMs: 2500, onTimeout },
      ),
      run.signal,
    );
    const reader = response.stream.getReader();
    for (let index = 0; index < 3; index++) {
      const next = reader.read();
      await jest.advanceTimersByTimeAsync(800);
      source.enqueue({ type, id: "output", delta: "a", rawValue: {} });
      expect((await next).done).toBe(false);
      // Simulate time spent by a downstream consumer (tool/approval/UI).
      await jest.advanceTimersByTimeAsync(10000);
    }
    const expired = reader.read();
    await jest.advanceTimersByTimeAsync(100);
    const part = (await expired).value;
    expect(part.type).toBe("error");
    expect(part.error.message).toBe("Provider total timed out after 2500ms");
    expect(isProviderResponseTimeout(part.error)).toBe(false);
    expect(isRetriableProviderStreamDisconnectError(part.error)).toBe(true);
    expect(
      getSubagentProviderRetryDecision(part.error, 0, {
        aborted: false,
        spendCapExceeded: false,
        hasStepsRemaining: true,
      }),
    ).toMatchObject({ category: "timeout", shouldRetry: true });
    expect(run.signal.aborted).toBe(false);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith({
      phase: "total",
      timeoutMs: 2500,
      modelId: "test-model",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect((await reader.read()).done).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  },
);

it("counts response wait toward the total and allows healthy reasoning to finish", async () => {
  const onTimeout = jest.fn();
  const response = open(
    withProviderStreamTimeout(
      makeModel(
        jest.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 600));
          return {
            stream: new ReadableStream({
              start(c) {
                c.enqueue({
                  type: "reasoning-delta",
                  id: "r",
                  delta: "thinking",
                });
                c.enqueue(finish());
                c.close();
              },
            }),
          };
        }),
      ),
      { timeoutMs: 1000, totalTimeoutMs: 1500, onTimeout },
    ),
  );
  await jest.advanceTimersByTimeAsync(600);
  const reader = (await response).stream.getReader();
  await jest.advanceTimersByTimeAsync(20000);
  expect((await reader.read()).value.type).toBe("reasoning-delta");
  expect((await reader.read()).value.type).toBe("finish");
  expect((await reader.read()).done).toBe(true);
  expect(onTimeout).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it("retains response time in the remaining stream budget", async () => {
  const response = open(
    withProviderStreamTimeout(
      makeModel(
        jest.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 600));
          return { stream: new ReadableStream() };
        }),
      ),
      { timeoutMs: 1000, totalTimeoutMs: 1500 },
    ),
  );
  await jest.advanceTimersByTimeAsync(600);
  const pending = (await response).stream.getReader().read();
  await jest.advanceTimersByTimeAsync(900);
  expect((await pending).value.error.message).toBe(
    "Provider total timed out after 1500ms",
  );
  expect(jest.getTimerCount()).toBe(0);
});

it("rejects and closes a response that wins the event loop race with an overdue deadline", async () => {
  let resolve!: (value: unknown) => void;
  const cancel = jest.fn();
  const onTimeout = jest.fn();
  const pending = open(
    withProviderStreamTimeout(
      makeModel(
        jest.fn(
          () =>
            new Promise((r) => {
              resolve = r;
            }),
        ),
      ),
      { timeoutMs: 2000, totalTimeoutMs: 1000, onTimeout },
    ),
  );
  const rejected = expect(pending).rejects.toThrow("Provider total timed out");
  await jest.advanceTimersByTimeAsync(0);
  // Move the monotonic clock without dispatching the queued timer.
  const now = jest.spyOn(performance, "now").mockReturnValue(1100);
  try {
    resolve({ stream: new ReadableStream({ cancel }) });
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    now.mockRestore();
  }
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
      { timeoutMs: 1000, totalTimeoutMs: 10000, onTimeout },
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
      { timeoutMs: 1000, totalTimeoutMs: 1500, onTimeout },
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
      totalTimeoutMs: 1500,
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
  const doStream = jest.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return {
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
            output.enqueue({
              type: "text-delta",
              id: "done",
              delta: "Finished",
            });
            output.enqueue({ type: "text-end", id: "done" });
            output.enqueue(finish());
          }
          output.close();
        },
      }),
    };
  });
  const onTimeout = jest.fn();
  const onError = jest.fn();
  const result = streamText({
    model: withProviderStreamTimeout(makeModel(doStream), {
      timeoutMs: 1000,
      totalTimeoutMs: 1000,
      onTimeout,
    }),
    prompt: "Wait, then report",
    tools: { wait: tool({ inputSchema: z.object({}), execute }) },
    stopWhen: stepCountIs(3),
    maxRetries: 0,
    onError,
  });
  const completed = result.consumeStream();
  await jest.advanceTimersByTimeAsync(7000);
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

it("reports a total stream timeout through the SDK without repeating completed tools", async () => {
  let source!: ReadableStreamDefaultController;
  const execute = jest.fn(async () => ({ ok: true }));
  const onError = jest.fn();
  const onAbort = jest.fn();
  const doStream = jest.fn(async () => ({
    stream: new ReadableStream({
      start(output) {
        if (doStream.mock.calls.length === 1) {
          output.enqueue({
            type: "tool-call",
            toolCallId: "once",
            toolName: "work",
            input: "{}",
          });
          output.enqueue(finish("tool-calls"));
          output.close();
        } else {
          source = output;
          output.enqueue({ type: "text-start", id: "answer" });
        }
      },
    }),
  }));
  const result = streamText({
    model: withProviderStreamTimeout(makeModel(doStream), {
      timeoutMs: 1000,
      totalTimeoutMs: 1500,
    }),
    prompt: "Work, then report",
    tools: { work: tool({ inputSchema: z.object({}), execute }) },
    stopWhen: stepCountIs(3),
    maxRetries: 0,
    onError,
    onAbort,
  });
  const completed = result.consumeStream();
  await jest.advanceTimersByTimeAsync(800);
  source.enqueue({ type: "text-delta", id: "answer", delta: "Partial" });
  await jest.advanceTimersByTimeAsync(700);
  await completed;
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError.mock.calls[0][0].error.message).toBe(
    "Provider total timed out after 1500ms",
  );
  expect(onAbort).not.toHaveBeenCalled();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(doStream).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(0);
});

it("does not mistake provider errors for local response timeouts", () => {
  expect(
    isProviderResponseTimeout(
      Object.assign(new Error("Provider response timed out after 1000ms"), {
        name: "ProviderStreamTimeoutError",
        phase: "response",
      }),
    ),
  ).toBe(false);
  expect(isProviderResponseTimeout(new Error("request timed out"))).toBe(false);
});
