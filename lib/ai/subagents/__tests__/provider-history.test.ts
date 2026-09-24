import { APICallError, streamText, type LanguageModel } from "ai";
import { WritableStream } from "node:stream/web";
import {
  withProviderModelHistory,
  type ProviderModelHistoryEntry,
} from "@/lib/ai/provider-model-history";
import { createSubagentProviderHistory } from "../provider-history";

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

const context = {
  subagent_id: "child-1",
  parent_trigger_run_id: "parent-1",
  trigger_run_id: "run-1",
  user_id: "user-1",
  environment: "PREVIEW",
};
const entry = (): ProviderModelHistoryEntry => ({
  timestamp: new Date().toISOString(),
  generation_step: 1,
  configured: "configured-model",
  requested: "requested-model",
  provider: "openrouter.chat",
  outcome: "pending",
});
const finish = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
};
const model = (doStream: jest.Mock): LanguageModel => ({
  specificationVersion: "v3",
  provider: "openrouter.chat",
  modelId: "requested-model",
  supportedUrls: {},
  doGenerate: jest.fn(),
  doStream,
});
const open = (languageModel: LanguageModel, abortSignal?: AbortSignal) => {
  if (typeof languageModel === "string") throw new Error("Expected model");
  return languageModel.doStream({ prompt: [], abortSignal });
};

it("records SDK retry attempts, provider IDs and model promotion without private content", async () => {
  const emit = jest.fn();
  const history = createSubagentProviderHistory(context, emit);
  const failure = new APICallError({
    message: "private provider error",
    url: "https://provider.example/private-target",
    requestBodyValues: { prompt: "private prompt" },
    statusCode: 503,
    responseHeaders: { "x-request-id": "failed-request" },
    isRetryable: true,
  });
  const doStream = jest
    .fn()
    .mockRejectedValueOnce(failure)
    .mockImplementation(async () => ({
      response: {
        headers: {
          "x-request-id": "successful-request",
          "set-cookie": "private cookie",
        },
      },
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({
            type: "response-metadata",
            id: "gen-success",
            modelId: "actual-model",
          });
          controller.enqueue(finish);
          controller.close();
        },
      }),
    }));
  const observe = (configured: string, attempt: number) =>
    withProviderModelHistory(model(doStream), {
      configured,
      generationStep: 1,
      onStart: (call) => history.record(call, attempt),
    });
  await streamText({
    model: observe("text-model", 1),
    prompt: "private prompt",
    maxRetries: 1,
  }).consumeStream();
  await streamText({
    model: observe("vision-model", 2),
    prompt: "private prompt",
    maxRetries: 0,
  }).consumeStream();
  history.flush(false);
  history.flush(true);
  expect(emit).toHaveBeenCalledTimes(1);
  const event = emit.mock.calls[0][0];
  expect(event).toMatchObject({
    ...context,
    request_id: "run-1",
    provider_call_count: 3,
    omitted_provider_call_count: 0,
  });
  expect(event.provider_calls).toMatchObject([
    {
      call_index: 1,
      generation_attempt: 1,
      configured: "text-model",
      outcome: "error",
      openrouter_request_id: "failed-request",
    },
    {
      call_index: 2,
      generation_attempt: 1,
      outcome: "completed",
      openrouter_request_id: "successful-request",
      actual: "actual-model",
    },
    {
      call_index: 3,
      generation_attempt: 2,
      configured: "vision-model",
      outcome: "completed",
    },
  ]);
  expect(JSON.stringify(event)).not.toMatch(
    /private|set-cookie|requestBodyValues/,
  );
});

it.each([false, true])(
  "retains cancellation before/after headers (headers=%s)",
  async (headersArrived) => {
    const emit = jest.fn();
    const history = createSubagentProviderHistory(context, emit);
    const abort = new AbortController();
    const cancel = jest.fn();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const observed = withProviderModelHistory(
      model(
        jest.fn(() => {
          started();
          return headersArrived
            ? Promise.resolve({
                response: { headers: { "x-request-id": "request-1" } },
                stream: new ReadableStream({ cancel }),
              })
            : new Promise(() => {});
        }),
      ),
      {
        configured: "text-model",
        generationStep: 2,
        onStart: (call) => history.record(call, 1),
      },
    );
    const pending = open(observed, abort.signal);
    await ready;
    const result = headersArrived ? await pending : undefined;
    abort.abort();
    if (result) await result.stream.cancel("stop");
    history.flush(true);
    expect(emit.mock.calls[0][0].provider_calls[0]).toMatchObject({
      outcome: "aborted",
      duration_ms: expect.any(Number),
    });
    expect(emit.mock.calls[0][0].provider_calls[0].openrouter_request_id).toBe(
      headersArrived ? "request-1" : undefined,
    );
    if (headersArrived) expect(cancel).toHaveBeenCalledWith("stop");
  },
);

it("keeps children isolated and snapshots a bounded tail with explicit omissions", () => {
  const emit = jest.fn();
  const first = createSubagentProviderHistory(context, emit);
  const second = createSubagentProviderHistory(
    { ...context, subagent_id: "child-2", trigger_run_id: "run-2" },
    emit,
  );
  const latest = entry();
  for (let i = 0; i < 20; i++) first.record(i === 19 ? latest : entry(), 1);
  second.record(
    { ...entry(), response_id: "second-response", requested: "x".repeat(513) },
    2,
  );
  latest.outcome = "completed";
  latest.response_id = "first-response";
  Object.assign(latest, {
    headers: { authorization: "secret" },
    error: "private",
  });
  first.flush(false);
  second.flush(true);
  latest.response_id = "mutated-after-flush";
  expect(emit.mock.calls[0][0]).toMatchObject({
    provider_call_count: 20,
    omitted_provider_call_count: 4,
  });
  expect(emit.mock.calls[0][0].provider_calls).toHaveLength(16);
  expect(emit.mock.calls[0][0].provider_calls[15]).toMatchObject({
    call_index: 20,
    outcome: "completed",
    response_id: "first-response",
  });
  expect(emit.mock.calls[1][0]).toMatchObject({
    subagent_id: "child-2",
    request_id: "run-2",
    provider_call_count: 1,
  });
  expect(emit.mock.calls[1][0].provider_calls[0]).toMatchObject({
    outcome: "aborted",
    response_id: "second-response",
    requested: undefined,
  });
  expect(JSON.stringify(emit.mock.calls)).not.toMatch(
    /secret|private|mutated-after-flush/,
  );
});

it("does not let a failed sink change cleanup and does not emit empty runs", () => {
  const emit = jest.fn(() => {
    throw new Error("offline");
  });
  createSubagentProviderHistory(context, emit).flush(false);
  expect(emit).not.toHaveBeenCalled();
  const history = createSubagentProviderHistory(context, emit);
  history.record(entry(), 1);
  expect(() => history.flush(false)).not.toThrow();
  history.record(entry(), 2);
  history.flush(true);
  expect(emit).toHaveBeenCalledTimes(1);
});
