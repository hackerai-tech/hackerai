import { withInferenceFallback } from "../inference-fallback";
import type { LanguageModelMiddleware } from "ai";

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
