import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { streamText, type LanguageModel } from "ai";
import { TextDecoderStream, WritableStream } from "node:stream/web";
import { withProviderStreamTimeout } from "../provider-stream-timeout";
import { extractOpenRouterMetadataFromError } from "@/lib/api/openrouter-metadata";
import {
  extractErrorDetails,
  getProviderStatusCode,
} from "@/lib/utils/error-utils";
import { getOpenRouterStreamErrorContext } from "@/lib/utils/openrouter-stream-error-context";
import { withOpenRouterStreamErrorContext } from "../openrouter-stream-error-context";

const edge = require("next/dist/compiled/@edge-runtime/primitives/fetch");
const replacements = {
  Request: edge.Request,
  Response: edge.Response,
  Headers: edge.Headers,
  TextDecoderStream,
  WritableStream,
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

it.each(["ask", "agent"])(
  "retains same-call IDs from actual SDK %s in-band errors without inventing HTTP status",
  async (mode) => {
    const fetch = jest.fn().mockResolvedValue(
      new Response(
        'data: {"error":{"message":"Internal provider error","code":502}}\n\ndata: [DONE]\n\n',
        {
          headers: {
            "content-type": "text/event-stream",
            "x-generation-id": "gen-current",
            "x-request-id": "req-current",
            "set-cookie": "PRIVATE_COOKIE_CANARY",
            authorization: "PRIVATE_AUTH_CANARY",
          },
        },
      ),
    );
    const errors: unknown[] = [];
    const result = streamText({
      model:
        mode === "agent"
          ? withProviderStreamTimeout(
              withOpenRouterStreamErrorContext(
                createOpenRouter({ apiKey: "synthetic-unused", fetch }).chat(
                  "test",
                ),
              ),
              { timeoutMs: 1000 },
            )
          : withOpenRouterStreamErrorContext(
              createOpenRouter({ apiKey: "synthetic-unused", fetch }).chat(
                "test",
              ),
            ),
      prompt: "synthetic",
      maxRetries: 0,
      onError: ({ error }) => {
        errors.push(error);
      },
    });
    const parts = [];
    for await (const part of result.fullStream) parts.push(part);
    expect(errors).toHaveLength(1);
    const error = errors[0];
    expect(parts.find((part) => part.type === "error")?.error).toBe(error);
    expect(getOpenRouterStreamErrorContext(error)).toEqual({
      version: 1,
      source: "sdk_error_part",
      headers: "present",
      association: "same_call",
      generationId: "gen-current",
      requestId: "req-current",
    });
    // Keep IDs out of operational metadata: that extractor can trigger an API lookup.
    expect(extractOpenRouterMetadataFromError(error)).toEqual({});
    expect(extractErrorDetails(error)).toMatchObject({
      errorCode: 502,
      openrouterStreamErrorContextVersion: 1,
      openrouterStreamErrorSource: "sdk_error_part",
      openrouterStreamErrorHeaders: "present",
      openrouterStreamErrorGenerationId: "gen-current",
      openrouterStreamErrorRequestId: "req-current",
    });
    expect(extractErrorDetails(error).statusCode).toBeUndefined();
    expect(getProviderStatusCode(extractErrorDetails(error))).toBe(502);
    expect(JSON.stringify(getOpenRouterStreamErrorContext(error))).not.toMatch(
      /PRIVATE_|authorization|cookie|message/i,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("associates a frozen error without mutating its shape or replacing the emitted part", async () => {
  const error = Object.freeze({
    code: 502,
    message: "Internal provider error",
  });
  const part = Object.freeze({ type: "error" as const, error });
  const model: LanguageModel = {
    specificationVersion: "v3",
    provider: "openrouter",
    modelId: "test",
    supportedUrls: {},
    doGenerate: jest.fn(),
    doStream: jest.fn().mockResolvedValue({
      stream: new ReadableStream({
        start(c) {
          c.enqueue(part);
          c.close();
        },
      }),
      response: { headers: { "x-request-id": "req-frozen" } },
    }),
  };
  const wrapped = withOpenRouterStreamErrorContext(model);
  if (typeof wrapped === "string") throw new Error("Expected model");
  const stream = (await wrapped.doStream({ prompt: [] })).stream;
  const read = await stream.getReader().read();
  expect(read.value).toBe(part);
  expect(getOpenRouterStreamErrorContext(error)?.requestId).toBe("req-frozen");
  expect(Reflect.ownKeys(error)).toEqual(["code", "message"]);
});

/** Exercise middleware forwarding with an owned SDK-shaped result. */
const open = async (parts: unknown[], headers: unknown, cancel = jest.fn()) => {
  const model: LanguageModel = {
    specificationVersion: "v3",
    provider: "openrouter",
    modelId: "synthetic",
    supportedUrls: {},
    doGenerate: jest.fn(),
    doStream: jest.fn().mockResolvedValue({
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          if (parts.length) controller.close();
        },
        cancel,
      }),
      response: { headers },
    }),
  };
  const wrapped = withOpenRouterStreamErrorContext(model);
  if (typeof wrapped === "string") throw new Error("Expected model");
  return { result: await wrapped.doStream({ prompt: [] }), model, wrapped };
};

it("keeps overlapping and preceding requests isolated, including absent IDs", async () => {
  const first = { code: 502 };
  const second = { code: 502 };
  const third = { code: 502 };
  const [a, b] = await Promise.all([
    open([{ type: "error", error: first }], {
      "x-generation-id": "gen-first",
      "request-id": "req-first",
    }),
    open([{ type: "error", error: second }], {
      "x-generation-id": "gen-second",
      "x-request-id": "req-second",
    }),
  ]);
  await b.result.stream.getReader().read();
  await a.result.stream.getReader().read();
  const c = await open([{ type: "error", error: third }], undefined);
  await c.result.stream.getReader().read();
  expect(getOpenRouterStreamErrorContext(first)?.generationId).toBe(
    "gen-first",
  );
  expect(getOpenRouterStreamErrorContext(second)?.generationId).toBe(
    "gen-second",
  );
  expect(getOpenRouterStreamErrorContext(third)).toEqual({
    version: 1,
    source: "sdk_error_part",
    headers: "absent",
    association: "same_call",
  });
  expect(extractOpenRouterMetadataFromError(third)).toEqual({});
});

it("declines reused error identity across calls instead of assigning a preceding response", async () => {
  const error = Object.freeze({ code: 502 });
  for (const request of ["req-first", "req-second", "req-third"]) {
    const { result } = await open([{ type: "error", error }], {
      "x-request-id": request,
    });
    expect((await result.stream.getReader().read()).value?.type).toBe("error");
  }
  expect(getOpenRouterStreamErrorContext(error)).toEqual({
    version: 1,
    source: "sdk_error_part",
    headers: "unattributable",
    association: "ambiguous",
  });
  expect(extractOpenRouterMetadataFromError(error)).toEqual({});
});

it.each([
  {
    headers: {
      "x-openrouter-generation-id": "gen-alias",
      "x-request-id": "req-alias",
    },
    state: "present",
    generationId: "gen-alias",
    requestId: "req-alias",
  },
  {
    headers: { "X-Generation-ID": "gen-valid", "REQUEST-ID": "req-valid" },
    state: "present",
    generationId: "gen-valid",
    requestId: "req-valid",
  },
  {
    headers: {
      "x-generation-id": `gen-${"a".repeat(129)}`,
      "x-request-id": "req-private/value",
    },
    state: "present",
  },
  {
    headers: {
      "x-generation-id": "PRIVATE_TARGET_CANARY",
      "x-request-id": "PRIVATE_KEY_CANARY",
    },
    state: "present",
  },
  {
    headers: Object.defineProperty({}, "x-request-id", {
      enumerable: true,
      get() {
        throw new Error("getter must not run");
      },
    }),
    state: "unreadable",
  },
  {
    headers: new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("unreadable");
        },
      },
    ),
    state: "unreadable",
  },
])(
  "bounds header context and safely handles $state input",
  async ({ headers, state, generationId, requestId }) => {
    const error = { code: 502 };
    const { result } = await open([{ type: "error", error }], headers);
    await result.stream.getReader().read();
    expect(getOpenRouterStreamErrorContext(error)).toEqual({
      version: 1,
      source: "sdk_error_part",
      association: "same_call",
      headers: state,
      ...(generationId ? { generationId } : {}),
      ...(requestId ? { requestId } : {}),
    });
  },
);

it("does not read private header getters or add data to serialized original errors", async () => {
  const getter = jest.fn(() => "PRIVATE_TOKEN_CANARY");
  const headers = Object.defineProperty(
    { "x-request-id": "req-safe" },
    "authorization",
    { enumerable: true, get: getter },
  );
  const error = { code: 502, message: "Internal provider error" };
  const before = JSON.stringify(error);
  const { result } = await open([{ type: "error", error }], headers);
  await result.stream.getReader().read();
  expect(getter).not.toHaveBeenCalled();
  expect(JSON.stringify(error)).toBe(before);
  expect(JSON.stringify(getOpenRouterStreamErrorContext(error))).not.toContain(
    "PRIVATE_",
  );
});

it("forwards success, primitive errors, cancellation and thrown stream failures unchanged", async () => {
  const delta = { type: "text-delta", id: "text", delta: "synthetic" };
  const primitive = { type: "error", error: "synthetic-string" };
  const { result, model, wrapped } = await open([delta, primitive], {});
  const reader = result.stream.getReader();
  expect((await reader.read()).value).toBe(delta);
  expect((await reader.read()).value).toBe(primitive);
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  expect(getOpenRouterStreamErrorContext(primitive.error)).toBeUndefined();
  expect(typeof wrapped === "string" ? undefined : wrapped.modelId).toBe(
    typeof model === "string" ? undefined : model.modelId,
  );
  const cancel = jest.fn();
  const waiting = await open([], {}, cancel);
  const reason = new Error("synthetic cancellation");
  await waiting.result.stream.cancel(reason);
  expect(cancel).toHaveBeenCalledWith(reason);
  const thrown = new Error("synthetic reader failure");
  const failedModel: LanguageModel = {
    specificationVersion: "v3",
    provider: "openrouter",
    modelId: "test",
    supportedUrls: {},
    doGenerate: jest.fn(),
    doStream: jest.fn().mockResolvedValue({
      stream: new ReadableStream({
        start(c) {
          c.error(thrown);
        },
      }),
    }),
  };
  const failed = withOpenRouterStreamErrorContext(failedModel);
  if (typeof failed === "string") throw new Error("Expected model");
  await expect(
    (await failed.doStream({ prompt: [] })).stream.getReader().read(),
  ).rejects.toBe(thrown);
  expect(getOpenRouterStreamErrorContext(thrown)).toBeUndefined();
});

it("preserves actual SDK text completion and non-streaming generation", async () => {
  const fetch = jest.fn().mockResolvedValue(
    new Response(
      'data: {"id":"gen-success","choices":[{"index":0,"delta":{"content":"synthetic success"},"finish_reason":null}]}\n\ndata: {"id":"gen-success","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      {
        headers: {
          "content-type": "text/event-stream",
          "x-request-id": "req-success",
        },
      },
    ),
  );
  const onError = jest.fn();
  const result = streamText({
    model: withOpenRouterStreamErrorContext(
      createOpenRouter({ apiKey: "synthetic-unused", fetch }).chat("test"),
    ),
    prompt: "synthetic",
    maxRetries: 0,
    onError,
  });
  expect(await result.text).toBe("synthetic success");
  expect(await result.finishReason).toBe("stop");
  expect(onError).not.toHaveBeenCalled();
  const generated = {
    content: [{ type: "text", text: "synthetic generation" }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {},
  };
  const doGenerate = jest.fn().mockResolvedValue(generated);
  const base: LanguageModel = {
    specificationVersion: "v3",
    provider: "openrouter",
    modelId: "test",
    supportedUrls: {},
    doGenerate,
    doStream: jest.fn(),
  };
  const model = withOpenRouterStreamErrorContext(base);
  if (typeof model === "string") throw new Error("Expected model");
  const params = { prompt: [] };
  expect(await model.doGenerate(params)).toBe(generated);
  expect(doGenerate).toHaveBeenCalledTimes(1);
  expect(doGenerate).toHaveBeenCalledWith(params);
});

it("delivers diagnostic-only context to existing Ask and Agent error sinks without inheriting a previous response", async () => {
  const { createChatLogger } = require("@/lib/api/chat-logger");
  const { phLogger } = require("@/lib/posthog/server");
  const phSpy = jest.spyOn(phLogger, "error").mockImplementation(() => {});
  const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  try {
    const error = { code: 502, message: "Owned INTERNAL fixture" };
    const { result } = await open([{ type: "error", error }], {
      "x-generation-id": "gen-current-sink",
      "x-request-id": "req-current-sink",
      "set-cookie": "PRIVATE_COOKIE_CANARY",
    });
    await result.stream.getReader().read();
    for (const endpoint of ["/api/chat", "/api/agent"]) {
      const logger = createChatLogger({
        chatId: "owned-sink-fixture",
        endpoint,
      });
      logger.setModelResponse("previous/model", {
        provider_name: "PreviousProvider",
        openrouter_generation_id: "gen-previous",
      });
      logger.recordProviderError(error, {
        requestedModelSlug: "x-ai/grok-4.6",
      });
      const fields = phSpy.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(fields).toMatchObject({
        openrouterStreamErrorContextVersion: 1,
        openrouterStreamErrorSource: "sdk_error_part",
        openrouterStreamErrorAssociation: "same_call",
        openrouterStreamErrorGenerationId: "gen-current-sink",
        openrouterStreamErrorRequestId: "req-current-sink",
        providerErrorCategory: "provider_5xx",
      });
      expect(fields.openrouter_generation_id).toBeUndefined();
      expect(fields.provider_name).toBeUndefined();
      expect(fields.statusCode).toBeUndefined();
      expect(JSON.stringify(fields)).not.toMatch(
        /PRIVATE_|gen-previous|PreviousProvider/,
      );
    }
    expect(JSON.stringify(errorSpy.mock.calls)).toContain("req-current-sink");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("PRIVATE_");
  } finally {
    phSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  }
});
