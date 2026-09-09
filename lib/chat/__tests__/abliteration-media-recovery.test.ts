import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  WritableStream as NodeWritableStream,
  TextDecoderStream as NodeTextDecoderStream,
} from "node:stream/web";
import {
  streamText,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import { createAbliterationMediaRecovery } from "../abliteration-media-recovery";
import { createAbliterationVisionPreprocessor } from "../abliteration-vision";

jest.mock("server-only", () => ({}));
jest.mock("../auxiliary-vision", () => ({
  describeImageWithAuxiliaryVision: jest.fn(),
}));

const originalWritableStream = globalThis.WritableStream;
const originalTextDecoderStream = globalThis.TextDecoderStream;
const originalResponse = globalThis.Response;
const originalHeaders = globalThis.Headers;
const edgeFetchPrimitives = jest.requireActual(
  "next/dist/compiled/@edge-runtime/primitives/fetch",
);
beforeAll(() => {
  Object.defineProperty(globalThis, "TextDecoderStream", {
    configurable: true,
    value: NodeTextDecoderStream,
  });
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: NodeWritableStream,
  });
  globalThis.Response = edgeFetchPrimitives.Response;
  globalThis.Headers = edgeFetchPrimitives.Headers;
});
afterAll(() => {
  Object.defineProperty(globalThis, "TextDecoderStream", {
    configurable: true,
    value: originalTextDecoderStream,
  });
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: originalWritableStream,
  });
  globalThis.Response = originalResponse;
  globalThis.Headers = originalHeaders;
});

type Params = Parameters<
  NonNullable<LanguageModelMiddleware["wrapStream"]>
>[0]["params"];
const mediaError = (code = "media_dimensions_too_large", statusCode = 413) =>
  Object.assign(new Error("media rejected"), {
    statusCode,
    responseBody: JSON.stringify({ error: { code } }),
  });
const prompt = (): Params["prompt"] => [
  { role: "system", content: "trusted instruction" },
  {
    role: "user",
    content: [
      { type: "text", text: "Read the image" },
      {
        type: "file",
        data: new URL("https://example.test/image.png"),
        mediaType: "image/png",
        filename: "screenshot.png",
      },
    ],
  },
];
const success = () => ({
  stream: new ReadableStream({
    start(c) {
      c.close();
    },
  }),
});
const setup = () => {
  const controller = new AbortController();
  const onCost = jest.fn();
  const describe = jest.fn(async (args) => {
    args.onCost(0.01);
    return {
      description: "Visible <text>",
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      model: "vision",
    };
  });
  const preprocess = createAbliterationVisionPreprocessor({
    userId: "user",
    chatId: "chat",
    abortSignal: controller.signal,
    onCost,
    describe,
  });
  const wrap = createAbliterationMediaRecovery(preprocess, controller.signal);
  const doStream = jest.fn(async (_params: Params) => success());
  const model = {
    specificationVersion: "v3",
    provider: "test",
    modelId: "abliterated-model",
    supportedUrls: {},
    doStream,
    doGenerate: jest.fn(),
  } as const;
  const wrapped = wrap(model);
  if (typeof wrapped === "string") throw new Error("Expected model object");
  return { controller, onCost, describe, wrap, doStream, model, wrapped };
};

it.each([
  ["media_dimensions_too_large", 413],
  ["media_type_unsupported", 415],
])("recovers %s once with OCR on the same model", async (code, status) => {
  const { doStream, wrapped, describe, onCost } = setup();
  doStream.mockRejectedValueOnce(mediaError(String(code), Number(status)));
  const original = prompt();
  const params: Params = {
    prompt: original,
    maxOutputTokens: 123,
    temperature: 0.5,
  };
  await wrapped.doStream(params);

  expect(wrapped.modelId).toBe("abliterated-model");
  expect(doStream).toHaveBeenCalledTimes(2);
  expect(doStream.mock.calls[0][0].prompt).toBe(original);
  const recovered = doStream.mock.calls[1][0];
  expect(recovered).toMatchObject({ maxOutputTokens: 123, temperature: 0.5 });
  expect(recovered.prompt[0]).toEqual(original[0]);
  expect(JSON.stringify(recovered.prompt)).toContain("Visible &lt;text&gt;");
  expect(JSON.stringify(recovered.prompt)).toContain("screenshot.png");
  expect(JSON.stringify(recovered.prompt)).not.toContain(
    "https://example.test",
  );
  expect(original[1].content[1]).toHaveProperty("type", "file");
  expect(describe).toHaveBeenCalledTimes(1);
  expect(onCost).toHaveBeenCalledWith(0.01);
});

it("keeps native input on success", async () => {
  const { wrapped, doStream, describe } = setup();
  const original = prompt();
  await wrapped.doStream({ prompt: original });
  expect(doStream).toHaveBeenCalledTimes(1);
  expect(doStream.mock.calls[0][0].prompt).toBe(original);
  expect(describe).not.toHaveBeenCalled();
});

it("describes provider tool images with their IDs and surrounding text intact", async () => {
  const { wrapped, doStream, describe } = setup();
  doStream.mockRejectedValueOnce(mediaError());
  const messages = prompt();
  messages.push({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "view-1",
        toolName: "file",
        output: {
          type: "content",
          value: [
            { type: "text", text: "tool context" },
            { type: "image-data", data: "AQID", mediaType: "image/png" },
          ],
        },
      },
    ],
  });
  await wrapped.doStream({ prompt: messages });
  expect(describe).toHaveBeenCalledTimes(2);
  expect(describe).toHaveBeenLastCalledWith(
    expect.objectContaining({ source: "file_view", image: "AQID" }),
  );
  expect(doStream.mock.calls[1][0].prompt[2]).toMatchObject({
    role: "tool",
    content: [
      {
        toolCallId: "view-1",
        toolName: "file",
        output: {
          value: [{ type: "text", text: "tool context" }, { type: "text" }],
        },
      },
    ],
  });
  expect(messages[2].content[0]).toHaveProperty(
    "output.value.1.type",
    "image-data",
  );
});

it.each([
  ["moderation_blocked", 400],
  ["invalid_request", 400],
  ["media_dimensions_too_large", 500],
  ["media_type_unsupported", 400],
  ["unknown", 413],
])("does not recover %s status %s", async (code, status) => {
  const { wrapped, doStream, describe } = setup();
  const error = mediaError(String(code), Number(status));
  doStream.mockRejectedValue(error);
  await expect(wrapped.doStream({ prompt: prompt() })).rejects.toBe(error);
  expect(doStream).toHaveBeenCalledTimes(1);
  expect(describe).not.toHaveBeenCalled();
});

it("does not alter baseline providers or retry text-only input", async () => {
  const { wrap, model, wrapped, doStream, describe } = setup();
  const baseline = { ...model, modelId: "baseline" };
  expect(wrap(baseline)).toBe(baseline);
  const error = mediaError();
  doStream.mockRejectedValue(error);
  await expect(
    wrapped.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }),
  ).rejects.toBe(error);
  expect(doStream).toHaveBeenCalledTimes(1);
  expect(describe).not.toHaveBeenCalled();
});

it("shares activation and cached summaries across wrappers and retries", async () => {
  const { wrap, model, wrapped, doStream, describe } = setup();
  const error = mediaError();
  doStream.mockRejectedValue(error);
  const params = { prompt: prompt() };
  await expect(wrapped.doStream(params)).rejects.toBe(error);
  const another = wrap(model) as Exclude<LanguageModel, string>;
  await expect(another.doStream(params)).rejects.toBe(error);
  expect(doStream).toHaveBeenCalledTimes(3);
  expect(describe).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(doStream.mock.calls[2][0].prompt)).not.toContain(
    '"type":"file"',
  );
});

it("fails closed on OCR failure without replaying its failed batch", async () => {
  const { wrapped, doStream, describe } = setup();
  doStream.mockRejectedValue(mediaError());
  describe.mockRejectedValue(new Error("private provider response"));
  const params = { prompt: prompt() };
  await expect(wrapped.doStream(params)).rejects.toHaveProperty(
    "name",
    "AbliterationVisionError",
  );
  await expect(wrapped.doStream(params)).rejects.toHaveProperty(
    "name",
    "AbliterationVisionError",
  );
  expect(doStream).toHaveBeenCalledTimes(1);
  expect(describe).toHaveBeenCalledTimes(1);
});

it("honors cancellation during OCR and never makes a second provider request", async () => {
  const { controller, wrapped, doStream, describe } = setup();
  doStream.mockRejectedValueOnce(mediaError());
  describe.mockImplementationOnce(async () => {
    controller.abort();
    return {
      description: "text",
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      model: "vision",
    };
  });
  await expect(wrapped.doStream({ prompt: prompt() })).rejects.toHaveProperty(
    "name",
    "AbortError",
  );
  expect(doStream).toHaveBeenCalledTimes(1);
});

it("does not start a request or OCR for an already-canceled SDK attempt", async () => {
  const { wrapped, doStream, describe } = setup();
  const canceled = new AbortController();
  canceled.abort();
  await expect(
    wrapped.doStream({ prompt: prompt(), abortSignal: canceled.signal }),
  ).rejects.toHaveProperty("name", "AbortError");
  expect(doStream).not.toHaveBeenCalled();
  expect(describe).not.toHaveBeenCalled();
});

it("cancels a pending transport read without synthesizing a provider failure", async () => {
  const { wrapped, doStream } = setup();
  const cancel = jest.fn();
  doStream.mockResolvedValueOnce({ stream: new ReadableStream({ cancel }) });
  const result = await wrapped.doStream({ prompt: prompt() });
  const reader = result.stream.getReader();
  const pending = reader.read();
  await reader.cancel("user stopped");
  await expect(pending).resolves.toEqual({ done: true, value: undefined });
  expect(cancel).toHaveBeenCalledWith("user stopped");
});

it("does not replay an error after the provider returned a stream", async () => {
  const { wrapped, doStream, describe } = setup();
  const error = mediaError();
  doStream.mockResolvedValueOnce({
    stream: new ReadableStream({
      start(c) {
        c.error(error);
      },
    }),
  });
  const result = await wrapped.doStream({ prompt: prompt() });
  const reader = result.stream.getReader();
  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: { type: "error", error },
  });
  await expect(reader.read()).resolves.toEqual({
    done: true,
    value: undefined,
  });
  expect(doStream).toHaveBeenCalledTimes(1);
  expect(describe).not.toHaveBeenCalled();
});

it("completes through the real OpenAI-compatible adapter after HTTP 413", async () => {
  const { wrap, describe } = setup();
  const bodies: Array<Record<string, any>> = [];
  const provider = createOpenAICompatible({
    name: "abliteration",
    baseURL: "https://provider.test/v1",
    apiKey: "synthetic-test-key",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1)
        return new Response(
          JSON.stringify({
            error: {
              message: "Image dimensions exceed the project media policy.",
              code: "media_dimensions_too_large",
            },
          }),
          { status: 413, headers: { "content-type": "application/json" } },
        );
      return new Response(
        'data: {"id":"test","model":"abliterated-model","choices":[{"index":0,"delta":{"content":"Recovered answer"},"finish_reason":null}]}\n\ndata: {"id":"test","model":"abliterated-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const result = streamText({
    model: wrap(provider("abliterated-model")),
    maxRetries: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Read image" },
          {
            type: "image",
            image: new Uint8Array([1, 2, 3]),
            mediaType: "image/png",
          },
        ],
      },
    ],
  });
  expect(await result.text).toBe("Recovered answer");
  expect(bodies).toHaveLength(2);
  expect(bodies.map((b) => b.model)).toEqual([
    "abliterated-model",
    "abliterated-model",
  ]);
  expect(bodies[0].messages[0].content).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "image_url" })]),
  );
  expect(JSON.stringify(bodies[1].messages)).not.toContain("image_url");
  expect(describe).toHaveBeenCalledWith(
    expect.objectContaining({ image: "AQID", mediaType: "image/png" }),
  );
});
