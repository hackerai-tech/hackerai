import {
  convertToModelMessages,
  readUIMessageStream,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type UIMessage,
} from "ai";
import { WritableStream } from "node:stream/web";
import { z } from "zod";
import { isRetriableProviderStreamDisconnectError } from "@/lib/utils/error-utils";
import { withProviderStreamTimeout } from "@/lib/ai/provider-stream-timeout";
import {
  decideProviderRecovery,
  prepareProviderDisconnectContinuation,
  shouldRetryProviderStreamWithFallback,
} from "../agent-long-provider-retry";
import { getProviderToolCallDiagnostics } from "../provider-tool-call-batches";

const descriptors = ["WritableStream", "structuredClone"].map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
beforeAll(() => {
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: WritableStream,
  });
  Object.defineProperty(globalThis, "structuredClone", {
    configurable: true,
    value: (v: unknown) => JSON.parse(JSON.stringify(v)),
  });
});
afterAll(() => {
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const finish = (reason: string) => ({
  type: "finish",
  finishReason: { unified: reason, raw: reason },
  usage,
});
const model = (doStream: jest.Mock): LanguageModel =>
  ({
    specificationVersion: "v3",
    provider: "test",
    modelId: "test",
    supportedUrls: {},
    doStream,
    doGenerate: jest.fn(),
  }) as LanguageModel;
const response = (parts: unknown[]) => ({
  stream: new ReadableStream({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part));
      controller.close();
    },
  }),
});

afterEach(() => jest.useRealTimers());

it.each(["504", "idle_timeout"])(
  "recovers %s after tool execution through real SDK/UI streams without executing the tool twice",
  async (failureMode) => {
    if (failureMode === "idle_timeout") jest.useFakeTimers();
    const execute = jest.fn(async () => ({ saved: true }));
    const tools = { save: tool({ inputSchema: z.object({}), execute }) };
    const upstreamError = { code: 504, message: "The operation was aborted" };
    const primary = jest
      .fn()
      .mockResolvedValueOnce(
        response([
          {
            type: "tool-call",
            toolCallId: "saved-once",
            toolName: "save",
            input: "{}",
          },
          finish("tool-calls"),
        ]),
      )
      .mockResolvedValueOnce(
        failureMode === "idle_timeout"
          ? {
              stream: new ReadableStream({
                start(output) {
                  output.enqueue({ type: "text-start", id: "partial" });
                  output.enqueue({
                    type: "text-delta",
                    id: "partial",
                    delta: "incomplete",
                  });
                },
              }),
            }
          : response([
              { type: "text-start", id: "partial" },
              { type: "text-delta", id: "partial", delta: "incomplete" },
              { type: "error", error: upstreamError },
            ]),
      );
    let failure: unknown;
    const initial = streamText({
      model: withProviderStreamTimeout(model(primary), { timeoutMs: 1000 }),
      messages: [{ role: "user", content: "save and report" }],
      tools,
      stopWhen: stepCountIs(3),
      maxRetries: 0,
      onError: ({ error }) => {
        failure = error;
      },
    });
    let partial: UIMessage | undefined;
    const readInitial = (async () => {
      for await (const message of readUIMessageStream({
        stream: initial.toUIMessageStream(),
        onError: () => {},
      }))
        partial = message;
    })();
    if (failureMode === "idle_timeout")
      await jest.advanceTimersByTimeAsync(1100);
    await readInitial;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(isRetriableProviderStreamDisconnectError(failure)).toBe(true);
    const continuation = prepareProviderDisconnectContinuation([partial!]);
    expect(continuation?.preservedCompletedToolCount).toBe(1);
    const messages = await convertToModelMessages(continuation!.messages, {
      tools,
    });
    expect(getProviderToolCallDiagnostics(messages)).toMatchObject({
      unmatched_tool_call_count: 0,
      unmatched_tool_result_count: 0,
    });
    expect(JSON.stringify(messages)).not.toContain("incomplete");
    const fallback = jest
      .fn()
      .mockResolvedValue(
        response([
          { type: "text-start", id: "done" },
          { type: "text-delta", id: "done", delta: "Saved successfully." },
          { type: "text-end", id: "done" },
          finish("stop"),
        ]),
      );
    const recovered = streamText({
      model: model(fallback),
      messages,
      tools,
      maxRetries: 0,
    });
    let final: UIMessage | undefined;
    const parseErrors: unknown[] = [];
    for await (const message of readUIMessageStream({
      stream: recovered.toUIMessageStream(),
      onError: (e) => parseErrors.push(e),
    }))
      final = message;
    expect(parseErrors).toEqual([]);
    expect(final?.parts).toContainEqual({
      type: "text",
      text: "Saved successfully.",
      state: "done",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      fallback.mock.calls[0][0].prompt.some(
        (message: { role: string }) => message.role === "tool",
      ),
    ).toBe(true);
  },
);

it("recognizes HTTP rejection delivered asynchronously before any content, with cancellation and retry limits intact", async () => {
  let failure: unknown;
  const rejected = streamText({
    model: model(
      jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("Invalid request"), { statusCode: 400 }),
        ),
    ),
    prompt: "test",
    maxRetries: 0,
    onError: ({ error }) => {
      failure = error;
    },
  });
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({
    stream: rejected.toUIMessageStream(),
    onError: () => {},
  }))
    last = message;
  expect(failure).toBeDefined();
  const hasCandidate = shouldRetryProviderStreamWithFallback(
    last?.parts ?? [],
    { hasTerminalProviderStreamError: true },
  );
  expect(hasCandidate).toBe(true);
  const eligible = {
    hasCandidate,
    modelEligible: true,
    userCancelled: false,
    unrecoverableVision: false,
    alreadyRetried: false,
    streamAborted: false,
    loopRecovery: false,
  };
  expect(decideProviderRecovery(eligible).attempt).toBe(true);
  expect(
    decideProviderRecovery({ ...eligible, userCancelled: true }).attempt,
  ).toBe(false);
  expect(
    decideProviderRecovery({ ...eligible, alreadyRetried: true }).attempt,
  ).toBe(false);
});
