import type { LanguageModel, LanguageModelMiddleware } from "ai";
import { withProviderRequestSizeRecovery } from "../provider-request-size-recovery";

type Params = Parameters<
  NonNullable<LanguageModelMiddleware["wrapStream"]>
>[0]["params"];
const params: Params = {
  prompt: [
    { role: "system", content: "Keep permissions and safety gates." },
    { role: "user", content: [{ type: "text", text: "history ".repeat(100) }] },
  ],
  tools: [
    { type: "function", name: "inspect", inputSchema: { type: "object" } },
  ],
  toolChoice: { type: "tool", toolName: "inspect" },
  providerOptions: { test: { marker: "preserve" } },
};
const rejection = (statusCode = 413, message = "Request body too large") =>
  Object.assign(new Error(message), { statusCode });
const setup = () => {
  const controller = new AbortController();
  const state = { attempted: false };
  const result = {
    stream: new ReadableStream({
      start(c) {
        c.close();
      },
    }),
  };
  const doStream = jest.fn().mockResolvedValue(result);
  const model = {
    specificationVersion: "v3",
    modelId: "test-model",
    provider: "test",
    supportedUrls: {},
    doStream,
    doGenerate: jest.fn(),
  } as LanguageModel;
  const compact = jest
    .fn<Promise<string | undefined>, []>()
    .mockResolvedValue(
      "Summary: completed tool effects are recorded; continue from here.",
    );
  const commit = jest.fn();
  const wrap = (nextModel = model) =>
    withProviderRequestSizeRecovery(nextModel, {
      state,
      abortSignal: controller.signal,
      compact,
      commit,
    }) as Exclude<LanguageModel, string>;
  return { controller, state, result, doStream, model, compact, commit, wrap };
};

describe("provider request size recovery", () => {
  it.each([
    [413, "Content-Length 5247064 exceeds 5242880 byte limit"],
    [413, "Request exceeds this provider's 2 MB limit"],
    [400, "maximum context length exceeded"],
  ])(
    "compacts once after pre-stream %i rejection and preserves request controls",
    async (status, message) => {
      const h = setup();
      h.doStream.mockRejectedValueOnce(rejection(status, message));
      await expect(h.wrap().doStream(params)).resolves.toBe(h.result);
      const retry = h.doStream.mock.calls[1][0];
      expect(retry).toMatchObject({
        tools: params.tools,
        toolChoice: params.toolChoice,
        providerOptions: params.providerOptions,
      });
      expect(retry.prompt).toEqual([
        params.prompt[0],
        {
          role: "user",
          content: [
            { type: "text", text: await h.compact.mock.results[0].value },
          ],
        },
      ]);
      expect(h.commit).toHaveBeenCalledTimes(1);
      expect(h.doStream).toHaveBeenCalledTimes(2);
    },
  );

  it("shares one recovery budget across wrappers and propagates a second rejection", async () => {
    const h = setup();
    const error = rejection();
    h.doStream.mockRejectedValue(error);
    await expect(h.wrap().doStream(params)).rejects.toBe(error);
    await expect(h.wrap().doStream(params)).rejects.toBe(error);
    expect(h.compact).toHaveBeenCalledTimes(1);
    expect(h.doStream).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, "larger ".repeat(1000)])(
    "does not retry or commit a missing/ineffective summary",
    async (summary) => {
      const h = setup();
      const error = rejection();
      h.doStream.mockRejectedValue(error);
      h.compact.mockResolvedValue(summary);
      await expect(h.wrap().doStream(params)).rejects.toBe(error);
      expect(h.doStream).toHaveBeenCalledTimes(1);
      expect(h.commit).not.toHaveBeenCalled();
    },
  );

  it("honors cancellation during compaction before committing or retrying", async () => {
    const h = setup();
    h.doStream.mockRejectedValueOnce(rejection());
    h.compact.mockImplementation(async () => {
      h.controller.abort();
      return "short";
    });
    await expect(h.wrap().doStream(params)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(h.doStream).toHaveBeenCalledTimes(1);
    expect(h.commit).not.toHaveBeenCalled();
  });

  it.each([
    rejection(400, "Invalid tool schema"),
    rejection(429, "rate limit"),
    rejection(413, "Downloaded image content cannot exceed 30MB"),
    Object.assign(rejection(), {
      responseBody: JSON.stringify({
        error: { code: "media_dimensions_too_large" },
      }),
    }),
  ])(
    "leaves unrelated and media failures to their existing handlers",
    async (error) => {
      const h = setup();
      h.doStream.mockRejectedValue(error);
      await expect(h.wrap().doStream(params)).rejects.toBe(error);
      expect(h.compact).not.toHaveBeenCalled();
    },
  );

  it("never replays a size error emitted after a stream has started", async () => {
    const h = setup();
    const partial = {
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: "text-delta", id: "t", delta: "partial" });
          c.enqueue({ type: "error", error: rejection() });
          c.close();
        },
      }),
    };
    h.doStream.mockResolvedValue(partial);
    const result = await h.wrap().doStream(params);
    const reader = result.stream.getReader();
    expect((await reader.read()).value).toMatchObject({ type: "text-delta" });
    expect((await reader.read()).value).toMatchObject({ type: "error" });
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.doStream).toHaveBeenCalledTimes(1);
  });
});
