import { readUIMessageStream, type UIMessageChunk } from "ai";
import { createAgentUiMessageStream } from "../agent-ui-message-stream";
import { deserialize, serialize } from "node:v8";
import { WritableStream } from "node:stream/web";

const descriptors = ["structuredClone", "WritableStream"].map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
beforeAll(() => {
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

/** Observe both published chunks and actual AI SDK client error handling. */
async function observe(stream: ReadableStream<UIMessageChunk>) {
  const chunks: UIMessageChunk[] = [];
  const errors: Error[] = [];
  const recorded = stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        chunks.push(chunk);
        controller.enqueue(chunk);
      },
    }),
  );
  for await (const _message of readUIMessageStream({
    stream: recorded,
    onError: (error) => errors.push(error as Error),
  })) {
    /* Drain through the client parser. */
  }
  return { chunks, errors };
}

it.each(["reason", "AbortError"])(
  "publishes abort rather than an empty client error for matched Stop (%s)",
  async (kind) => {
    const stop = new AbortController();
    const reason = new Error("controlled Stop");
    stop.abort(reason);
    const formatter = jest.fn(() => "ordinary failure");
    const result = await observe(
      createAgentUiMessageStream({
        abortSignal: stop.signal,
        execute: async () => {
          throw kind === "reason"
            ? reason
            : new DOMException("stopped", "AbortError");
        },
        onError: formatter,
      }),
    );
    expect(result.chunks).toEqual([{ type: "abort" }]);
    expect(result.errors).toEqual([]);
    expect(formatter).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "preserves an unrelated real error even when Stop is already set (%s)",
  async (aborted) => {
    const stop = new AbortController();
    if (aborted) stop.abort(new Error("different Stop"));
    const failure = new Error("controlled real failure");
    const formatter = jest.fn(() => "visible real failure");
    const result = await observe(
      createAgentUiMessageStream({
        abortSignal: stop.signal,
        execute: async () => {
          throw failure;
        },
        onError: formatter,
      }),
    );
    expect(result.chunks).toEqual([
      { type: "error", errorText: "visible real failure" },
    ]);
    expect(result.errors.map((error) => error.message)).toEqual([
      "visible real failure",
    ]);
    expect(formatter).toHaveBeenCalledWith(failure);
  },
);

it("does not hide a genuine empty error after Stop or mistake another stream marker for cancellation", async () => {
  const stop = new AbortController();
  stop.abort(new Error("different Stop"));
  const failure = new Error("");
  const result = await observe(
    createAgentUiMessageStream({
      abortSignal: stop.signal,
      execute: async ({ writer }) => {
        writer.write({
          type: "error",
          errorText: "hackerai-cancel:foreign-stream",
        });
        throw failure;
      },
      onError: () => "",
    }),
  );
  expect(result.chunks).toEqual([
    { type: "error", errorText: "hackerai-cancel:foreign-stream" },
    { type: "error", errorText: "" },
  ]);
  expect(result.errors.map((error) => error.message)).toEqual([
    "hackerai-cancel:foreign-stream",
    "",
  ]);
});

it("keeps preceding stream data and translates only a rejected merged-stream cancellation", async () => {
  const stop = new AbortController();
  const result = await observe(
    createAgentUiMessageStream({
      abortSignal: stop.signal,
      execute: ({ writer }) => {
        writer.write({ type: "start", messageId: "message" });
        writer.write({ type: "text-start", id: "text" });
        writer.write({ type: "text-delta", id: "text", delta: "preserved" });
        writer.write({ type: "text-end", id: "text" });
        writer.merge(
          new ReadableStream({
            start(controller) {
              stop.abort(new DOMException("controlled Stop", "AbortError"));
              controller.error(stop.signal.reason);
            },
          }),
        );
      },
      onError: () => "visible real failure",
    }),
  );
  expect(result.chunks).toEqual([
    { type: "start", messageId: "message" },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: "preserved" },
    { type: "text-end", id: "text" },
    { type: "abort" },
  ]);
  expect(result.errors).toEqual([]);
});

it("retains an AbortError when the owning signal has not been canceled", async () => {
  const failure = new DOMException("different operation", "AbortError");
  const formatter = jest.fn(() => "visible independent abort");
  const result = await observe(
    createAgentUiMessageStream({
      abortSignal: new AbortController().signal,
      execute: async () => {
        throw failure;
      },
      onError: formatter,
    }),
  );
  expect(result.chunks).toEqual([
    { type: "error", errorText: "visible independent abort" },
  ]);
  expect(formatter).toHaveBeenCalledWith(failure);
});

it("preserves an error already being formatted when Stop arrives", async () => {
  const stop = new AbortController();
  const failure = new Error("real failure before Stop");
  const result = await observe(
    createAgentUiMessageStream({
      abortSignal: stop.signal,
      execute: async () => {
        throw failure;
      },
      onError: () => {
        stop.abort(new Error("later Stop"));
        return "visible earlier failure";
      },
    }),
  );
  expect(result.chunks).toEqual([
    { type: "error", errorText: "visible earlier failure" },
  ]);
  expect(result.errors.map((error) => error.message)).toEqual([
    "visible earlier failure",
  ]);
});

it("keeps a genuine merged-stream error alongside a separate matched cancellation", async () => {
  const stop = new AbortController();
  stop.abort(new Error("owned Stop"));
  const result = await observe(
    createAgentUiMessageStream({
      abortSignal: stop.signal,
      execute: ({ writer }) => {
        writer.merge(
          new ReadableStream({
            start: (controller) => controller.error(stop.signal.reason),
          }),
        );
        writer.merge(
          new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "error",
                errorText: "genuine merged failure",
              });
              controller.close();
            },
          }),
        );
      },
      onError: () => "visible failure",
    }),
  );
  expect(result.chunks.filter((chunk) => chunk.type === "abort")).toEqual([
    { type: "abort" },
  ]);
  expect(result.chunks.filter((chunk) => chunk.type === "error")).toEqual([
    { type: "error", errorText: "genuine merged failure" },
  ]);
  expect(result.errors.map((error) => error.message)).toEqual([
    "genuine merged failure",
  ]);
  expect(JSON.stringify(result)).not.toContain("hackerai-cancel:");
});

it("preserves a real formatter failure rather than converting it to cancellation", async () => {
  const formatterFailure = new Error("controlled formatter failure");
  const stream = createAgentUiMessageStream({
    abortSignal: new AbortController().signal,
    execute: async () => {
      throw new Error("independent source error");
    },
    onError: () => {
      throw formatterFailure;
    },
  });
  const result = await observe(stream);
  expect(result.chunks).toEqual([]);
  expect(result.errors).toEqual([formatterFailure]);
  expect(result.errors[0]).toBe(formatterFailure);
});

it("never exposes its private marker through the caller's tool error formatter", async () => {
  const stop = new AbortController();
  stop.abort(new Error("owned Stop"));
  const failure = new Error("independent tool failure");
  const formatter = jest.fn(() => "visible tool failure");
  const chunks: UIMessageChunk[] = [];
  const stream = createAgentUiMessageStream({
    abortSignal: stop.signal,
    execute: ({ writer }) => {
      writer.write({
        type: "tool-output-error",
        toolCallId: "stopped",
        errorText: writer.onError!(stop.signal.reason),
      });
      writer.write({
        type: "tool-output-error",
        toolCallId: "failed",
        errorText: writer.onError!(failure),
      });
      throw stop.signal.reason;
    },
    onError: formatter,
  });
  for await (const chunk of stream) chunks.push(chunk);
  expect(chunks).toEqual([
    { type: "tool-output-error", toolCallId: "stopped", errorText: "" },
    {
      type: "tool-output-error",
      toolCallId: "failed",
      errorText: "visible tool failure",
    },
    { type: "abort" },
  ]);
  expect(formatter).toHaveBeenCalledTimes(1);
  expect(formatter).toHaveBeenCalledWith(failure);
  expect(JSON.stringify(chunks)).not.toContain("hackerai-cancel:");
});
