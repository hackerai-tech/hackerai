import { withInferenceFallback } from "../inference-fallback";
import type { LanguageModelMiddleware } from "ai";
import { createAbliterationVisionPreprocessor } from "@/lib/chat/abliteration-vision";

jest.mock("server-only", () => ({}));
jest.mock("@/lib/chat/auxiliary-vision", () => ({
  ...jest.requireActual("@/lib/chat/auxiliary-vision"),
  describeImageWithAuxiliaryVision: jest.fn(),
}));

type Options = Parameters<
  NonNullable<LanguageModelMiddleware["wrapStream"]>
>[0];
type Model = Options["model"];
type Result = Awaited<ReturnType<Model["doStream"]>>;
type Part = Result["stream"] extends ReadableStream<infer P> ? P : never;
const usage = {
  inputTokens: {
    total: 100,
    noCache: 20,
    cacheRead: 80,
    cacheWrite: undefined,
  },
  outputTokens: { total: 32, text: 0, reasoning: 32 },
};
const text: Part[] = [
  { type: "response-metadata", modelId: "abliterated-model-large-flash" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "answer" },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];
function model(id: string, parts: Part[]) {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: id,
    supportedUrls: {},
    doGenerate: jest.fn(),
    doStream: jest.fn(async () => ({
      stream: new ReadableStream<Part>({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
    })),
  } satisfies Model;
}
function setup(parts: Part[] = text) {
  const primary = model("deepseek-v4.1-flash-1017-cyber", parts);
  const fallback = model("abliterated-model-large-flash", text);
  const controller = new AbortController();
  const onDiscardedUsage = jest.fn();
  const wrapped = withInferenceFallback(primary, fallback, {
    abortSignal: controller.signal,
    onDiscardedUsage,
    prepareFallbackPrompt: async (prompt) => prompt,
  });
  const run = () =>
    wrapped.doStream({
      prompt: [],
      providerOptions: { inference: { reasoningEffort: "max" } },
    });
  return { primary, fallback, controller, onDiscardedUsage, run };
}
async function collect(result: Result) {
  const reader = result.stream.getReader();
  const parts: Part[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}
it("keeps a successful primary and does not call the fallback", async () => {
  const s = setup();
  expect(await collect(await s.run())).toEqual(text);
  expect(s.fallback.doStream).not.toHaveBeenCalled();
});
it.each(
  [
    [
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ] as Part[],
    [{ type: "error", error: new Error("disconnect") }] as Part[],
  ].map((ending) => ({ ending })),
)("recovers whitespace-only output ending with $ending", async ({ ending }) => {
  const s = setup([
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: " \n\t" },
    ...ending,
  ]);
  expect(await collect(await s.run())).toEqual(text);
  expect(s.fallback.doStream).toHaveBeenCalledTimes(1);
});
it("retains leading whitespace when a later delta contains a valid answer", async () => {
  const parts: Part[] = [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: " \n\t" },
    ...text.slice(2),
  ];
  const s = setup(parts);
  expect(await collect(await s.run())).toEqual(parts);
  expect(s.fallback.doStream).not.toHaveBeenCalled();
});
it("uses the retained provider on an HTTP failure with its own options namespace", async () => {
  const s = setup();
  s.primary.doStream.mockRejectedValueOnce(new Error("503"));
  expect(await collect(await s.run())).toEqual(text);
  expect(s.fallback.doStream).toHaveBeenCalledWith(
    expect.objectContaining({
      providerOptions: { abliteration: { reasoningEffort: "max" } },
    }),
  );
});
it("prepares a twenty-image prompt only for the failed primary's Abliteration fallback", async () => {
  const s = setup();
  s.primary.doStream.mockRejectedValueOnce(new Error("503"));
  const describe = jest.fn(async () => ({
    description: "visible card evidence",
    model: "vision",
    inputTokens: 1,
    outputTokens: 1,
    durationMs: 1,
  }));
  const prepareFallbackPrompt = createAbliterationVisionPreprocessor({
    userId: "qa",
    chatId: "chat",
    abortSignal: s.controller.signal,
    onCost: jest.fn(),
    describe,
  });
  const prompt: Options["params"]["prompt"] = [
    {
      role: "user",
      content: Array.from({ length: 20 }, (_, i) => ({
        type: "image",
        image: new URL(`https://example.test/${i}.png`),
        mediaType: "image/png",
      })),
    },
  ];
  const wrapped = withInferenceFallback(s.primary, s.fallback, {
    abortSignal: s.controller.signal,
    onDiscardedUsage: s.onDiscardedUsage,
    prepareFallbackPrompt,
  });
  expect(await collect(await wrapped.doStream({ prompt }))).toEqual(text);
  expect(s.primary.doStream).toHaveBeenCalledWith(
    expect.objectContaining({ prompt }),
  );
  expect(describe).toHaveBeenCalledTimes(20);
  const fallbackPrompt = s.fallback.doStream.mock.calls[0]?.[0]?.prompt;
  expect(fallbackPrompt?.[0]).toMatchObject({
    role: "user",
    content: Array.from({ length: 20 }, (_, i) => ({
      type: "text",
      text: expect.stringContaining(`index="${i + 1}"`),
    })),
  });
  expect(prompt[0].content).toHaveLength(20);
  expect(prompt[0].content[0].type).toBe("image");
});

it("does not start the fallback when canceled during prompt preparation", async () => {
  const s = setup();
  s.primary.doStream.mockRejectedValueOnce(new Error("503"));
  const wrapped = withInferenceFallback(s.primary, s.fallback, {
    abortSignal: s.controller.signal,
    onDiscardedUsage: s.onDiscardedUsage,
    prepareFallbackPrompt: async (prompt) => {
      s.controller.abort();
      return prompt;
    },
  });
  await expect(wrapped.doStream({ prompt: [] })).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(s.fallback.doStream).not.toHaveBeenCalled();
});

it("does not send unprepared images to the fallback if preparation fails", async () => {
  const s = setup();
  s.primary.doStream.mockRejectedValueOnce(new Error("503"));
  const failure = new Error("image preparation failed");
  const wrapped = withInferenceFallback(s.primary, s.fallback, {
    abortSignal: s.controller.signal,
    onDiscardedUsage: s.onDiscardedUsage,
    prepareFallbackPrompt: async () => {
      throw failure;
    },
  });
  await expect(wrapped.doStream({ prompt: [] })).rejects.toBe(failure);
  expect(s.fallback.doStream).not.toHaveBeenCalled();
});
it("recovers reasoning-only truncation and records its usage before hiding it", async () => {
  const s = setup([
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: "private reasoning" },
    { type: "reasoning-end", id: "r" },
    {
      type: "finish",
      finishReason: { unified: "length", raw: "length" },
      usage,
    },
  ]);
  expect(await collect(await s.run())).toEqual(text);
  expect(s.onDiscardedUsage).toHaveBeenCalledTimes(1);
  expect(s.onDiscardedUsage).toHaveBeenCalledWith(usage);
});
it("falls back when the primary stream errors and cancellation rejects", async () => {
  const s = setup();
  s.primary.doStream.mockResolvedValueOnce({
    stream: new ReadableStream<Part>({
      start(controller) {
        controller.error(new Error("connection lost"));
      },
    }),
  });
  expect(await collect(await s.run())).toEqual(text);
  expect(s.fallback.doStream).toHaveBeenCalledTimes(1);
});
it.each([
  { type: "text-delta", id: "t", delta: "published" } as Part,
  { type: "tool-input-start", id: "call", toolName: "file" } as Part,
])(
  "does not replay after $type even if the following part is an error",
  async (first) => {
    const error = new Error("disconnected");
    const s = setup([first, { type: "error", error }]);
    expect(await collect(await s.run())).toEqual([
      first,
      { type: "error", error },
    ]);
    expect(s.fallback.doStream).not.toHaveBeenCalled();
  },
);
it("does not fall back after user cancellation", async () => {
  const s = setup();
  s.controller.abort();
  await expect(s.run()).rejects.toMatchObject({ name: "AbortError" });
  expect(s.primary.doStream).not.toHaveBeenCalled();
  expect(s.fallback.doStream).not.toHaveBeenCalled();
});
it("lets a failed Abliteration leg reach the existing outer baseline recovery", async () => {
  const s = setup([{ type: "error", error: new Error("primary") }]);
  const error = new Error("fallback");
  s.fallback.doStream.mockRejectedValueOnce(error);
  await expect(s.run()).rejects.toBe(error);
  expect(s.primary.doStream).toHaveBeenCalledTimes(1);
  expect(s.fallback.doStream).toHaveBeenCalledTimes(1);
});
