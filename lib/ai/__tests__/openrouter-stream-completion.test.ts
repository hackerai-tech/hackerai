import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  streamText,
  tool,
  readUIMessageStream,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
} from "ai";
import {
  decideProviderRecovery,
  prepareProviderDisconnectContinuation,
} from "@/lib/chat/agent-long-provider-retry";
import { TextDecoderStream, WritableStream } from "node:stream/web";
import { z } from "zod";
import { createOpenRouterPatchFetch } from "../providers";
import { isRetriableProviderStreamDisconnectError } from "@/lib/utils/error-utils";

const edge = require("next/dist/compiled/@edge-runtime/primitives/fetch");
const replacements = {
  Response: edge.Response,
  Headers: edge.Headers,
  TextDecoderStream,
  WritableStream,
  structuredClone: (value: unknown) => JSON.parse(JSON.stringify(value)),
};
const descriptors = Object.keys(replacements).map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
beforeAll(() => {
  for (const [key, value] of Object.entries(replacements))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
});
afterAll(() => {
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const event = (delta: object, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ id: "gen-test", model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const done = "data: [DONE]\n\n";
const response = (body: string | ReadableStream<Uint8Array>) =>
  new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "x-generation-id": "gen-test",
    },
  });
const consume = async (body: string, tools = {}) => {
  const fetch = jest.fn().mockResolvedValue(response(body));
  const onError = jest.fn();
  const result = streamText({
    model: createOpenRouter({
      apiKey: "synthetic-unused",
      fetch: createOpenRouterPatchFetch(fetch),
    }).chat("test"),
    prompt: "test",
    tools,
    onError,
    maxRetries: 0,
  });
  const parts = [];
  for await (const part of result.fullStream) parts.push(part);
  return { parts, onError, fetch };
};

it.each([
  ["empty", ""],
  ["partial text", event({ content: "partial" })],
  ["done without finish reason", event({ content: "partial" }) + done],
  [
    "usage only",
    'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":0,"total_tokens":1}}\n\n' +
      done,
  ],
  [
    "unfinished terminal event",
    event({ content: "partial" }) +
      'data: {"choices":[{"finish_reason":"stop"}]}',
  ],
])(
  "fails a clean EOF with %s through the actual provider adapter",
  async (_name, body) => {
    const { parts, onError, fetch } = await consume(body);
    expect(onError).toHaveBeenCalledTimes(1);
    const error = onError.mock.calls[0][0].error;
    expect(error).toMatchObject({
      message: expect.stringContaining("terminated"),
      responseHeaders: expect.objectContaining({
        "x-generation-id": "gen-test",
      }),
    });
    expect(isRetriableProviderStreamDisconnectError(error)).toBe(true);
    expect(
      parts.some(
        (part) => part.type === "finish" && part.finishReason !== "error",
      ),
    ).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    if (body.includes("partial"))
      expect(parts).toContainEqual(
        expect.objectContaining({ type: "text-delta", text: "partial" }),
      );
  },
);

it.each(["stop", "length", "content_filter", "future_reason"])(
  "accepts an observed %s terminal and preserves usage",
  async (reason) => {
    const usage = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`;
    const { parts, onError } = await consume(
      event({ content: "done" }) + event({}, reason) + usage + done,
    );
    expect(onError).not.toHaveBeenCalled();
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "finish",
        totalUsage: expect.objectContaining({
          inputTokens: 3,
          outputTokens: 2,
        }),
      }),
    );
  },
);

it("preserves an explicit provider error instead of replacing it with an EOF error", async () => {
  const { onError } = await consume(
    'data: {"error":{"code":503,"message":"Service unavailable"}}\n\n' + done,
  );
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError.mock.calls[0][0].error).toMatchObject({
    message: "Service unavailable",
  });
});

it("does not synthesize and execute a truncated tool call on EOF", async () => {
  const execute = jest.fn().mockResolvedValue({ saved: true });
  const { onError } = await consume(
    event({
      tool_calls: [
        {
          index: 0,
          id: "incomplete",
          type: "function",
          function: { name: "save", arguments: '{"value":' },
        },
      ],
    }),
    {
      save: tool({
        inputSchema: z.object({ value: z.string().optional() }),
        execute,
      }),
    },
  );
  expect(onError).toHaveBeenCalledTimes(1);
  expect(execute).not.toHaveBeenCalled();
});

it("handles UTF-8, comments, multiline data, and CRLF split across byte chunks", async () => {
  const body =
    '\ufeff: keepalive\r\n\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"é"},"finish_reason":"stop"}]}\r\n\r\n' +
    done;
  const bytes = new TextEncoder().encode(body);
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === bytes.length) controller.close();
      else controller.enqueue(bytes.slice(index, ++index));
    },
  });
  const fetch = createOpenRouterPatchFetch(
    jest.fn().mockResolvedValue(response(stream)),
  );
  const result = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    body: JSON.stringify({ stream: true }),
  });
  expect(await result.text()).toBe(body.slice(1));
});

it.each([
  ["/responses", true, "text/event-stream"],
  ["/chat/completions", false, "application/json"],
  ["/chat/completions", true, "application/json"],
])(
  "leaves other response contracts alone: %s %s %s",
  async (path, stream, contentType) => {
    const fetch = createOpenRouterPatchFetch(
      jest
        .fn()
        .mockResolvedValue(
          new Response("{}", { headers: { "content-type": contentType } }),
        ),
    );
    const result = await fetch(`https://openrouter.ai/api/v1${path}`, {
      body: JSON.stringify({ stream }),
    });
    expect(await result.text()).toBe("{}");
  },
);

it("forwards cancellation while an upstream read is pending without manufacturing EOF", async () => {
  const cancel = jest.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const fetch = createOpenRouterPatchFetch(
    jest.fn().mockResolvedValue(response(body)),
  );
  const result = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    body: JSON.stringify({ stream: true }),
  });
  const reader = result.body!.getReader();
  const pending = reader.read();
  await reader.cancel("user-stop");
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(cancel).toHaveBeenCalledWith("user-stop");
});

it("retains completed tools across one safe EOF continuation without replaying them", async () => {
  const execute = jest.fn(async () => ({ saved: true }));
  const tools = { save: tool({ inputSchema: z.object({}), execute }) };
  const fetch = jest
    .fn()
    .mockResolvedValueOnce(
      response(
        event(
          {
            tool_calls: [
              {
                index: 0,
                id: "saved-once",
                type: "function",
                function: { name: "save", arguments: "{}" },
              },
            ],
          },
          "tool_calls",
        ) + done,
      ),
    )
    .mockResolvedValueOnce(response(event({ content: "incomplete" })))
    .mockResolvedValueOnce(
      response(event({ content: "Saved successfully." }, "stop") + done),
    );
  const model = createOpenRouter({
    apiKey: "synthetic-unused",
    fetch: createOpenRouterPatchFetch(fetch),
  }).chat("test");
  const errors: unknown[] = [];
  const initial = streamText({
    model,
    prompt: "save and report",
    tools,
    stopWhen: stepCountIs(3),
    maxRetries: 0,
    onError: ({ error }) => {
      errors.push(error);
    },
  });
  let partial: UIMessage | undefined;
  for await (const message of readUIMessageStream({
    stream: initial.toUIMessageStream(),
    onError: () => {},
  }))
    partial = message;
  expect(errors).toHaveLength(1);
  expect(isRetriableProviderStreamDisconnectError(errors[0])).toBe(true);
  expect(execute).toHaveBeenCalledTimes(1);
  const continuation = prepareProviderDisconnectContinuation([partial!]);
  expect(continuation?.preservedCompletedToolCount).toBe(1);
  const decision = {
    userCancelled: false,
    unrecoverableVision: false,
    alreadyRetried: false,
    streamAborted: false,
    loopRecovery: false,
    hasCandidate: Boolean(continuation),
    modelEligible: true,
  };
  expect(decideProviderRecovery(decision).attempt).toBe(true);
  expect(
    decideProviderRecovery({ ...decision, userCancelled: true }).attempt,
  ).toBe(false);
  expect(
    decideProviderRecovery({ ...decision, alreadyRetried: true }).attempt,
  ).toBe(false);
  const messages = await convertToModelMessages(continuation!.messages, {
    tools,
  });
  expect(messages.some((message) => message.role === "tool")).toBe(true);
  const recovered = streamText({ model, messages, tools, maxRetries: 0 });
  expect(await recovered.text).toBe("Saved successfully.");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("preserves an abort reason when the upstream ends a pending read on Stop", async () => {
  const abort = new AbortController();
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const fetch = createOpenRouterPatchFetch(
    jest.fn().mockResolvedValue(
      response(
        new ReadableStream({
          start(controller) {
            upstream = controller;
          },
        }),
      ),
    ),
  );
  const result = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    body: JSON.stringify({ stream: true }),
    signal: abort.signal,
  });
  const pending = result.body!.getReader().read();
  abort.abort();
  upstream.close();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});
