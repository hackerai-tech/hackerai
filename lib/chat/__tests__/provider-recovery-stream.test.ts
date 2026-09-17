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
import {
  withProviderStreamTimeout,
  isProviderResponseTimeout,
} from "@/lib/ai/provider-stream-timeout";
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

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "settles an unfinished retained tool before fallback (later step: %s, completed tail: %s)",
  async (laterStep, allowCompletedTail) => {
    const execute = jest.fn();
    const tools = { save: tool({ inputSchema: z.object({}), execute }) };
    const unfinished = {
      type: "tool-save",
      toolCallId: "outcome-unknown",
      state: "input-available",
      input: {},
    };
    const completed = {
      type: "tool-save",
      toolCallId: "saved-once",
      state: "output-available",
      input: {},
      output: { saved: true },
    };
    const partial = {
      id: "partial",
      role: "assistant",
      parts: [
        { type: "step-start" },
        unfinished,
        ...(laterStep ? [{ type: "step-start" }] : []),
        completed,
        ...(allowCompletedTail
          ? []
          : [{ type: "text", text: "incomplete", state: "streaming" }]),
      ],
    } as UIMessage;
    const continuation = prepareProviderDisconnectContinuation([partial], {
      allowCompletedTail,
    });
    const messages = await convertToModelMessages(
      [
        { id: "user", role: "user", parts: [{ type: "text", text: "Save" }] },
        ...continuation!.messages,
        {
          id: "continue",
          role: "user",
          parts: [{ type: "text", text: "Report" }],
        },
      ],
      { tools },
    );
    const fallback = jest
      .fn()
      .mockResolvedValue(
        response([
          { type: "text-start", id: "done" },
          { type: "text-delta", id: "done", delta: "One result is unknown." },
          { type: "text-end", id: "done" },
          finish("stop"),
        ]),
      );
    const errors: unknown[] = [];
    const recovered = streamText({
      model: model(fallback),
      messages,
      tools,
      maxRetries: 0,
      onError: ({ error }) => errors.push(error),
    });
    let final: UIMessage | undefined;
    for await (const message of readUIMessageStream({
      stream: recovered.toUIMessageStream(),
      onError: (error) => errors.push(error),
    }))
      final = message;
    expect(errors).toEqual([]);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(final?.parts).toContainEqual({
      type: "text",
      text: "One result is unknown.",
      state: "done",
    });
    expect(getProviderToolCallDiagnostics(messages)).toMatchObject({
      unmatched_tool_call_count: 0,
      unmatched_tool_result_count: 0,
    });
    expect(continuation?.preservedCompletedToolCount).toBe(1);
    expect(continuation?.messages[0].parts).toContainEqual(completed);
    expect(continuation?.messages[0].parts).toContainEqual({
      ...unfinished,
      state: "output-error",
      errorText: expect.stringContaining("outcome is unknown"),
    });
    expect(unfinished.state).toBe("input-available");
  },
);

it.each(["504", "idle_timeout", "response_timeout"])(
  "recovers %s after tool execution through real SDK/UI streams without executing the tool twice",
  async (failureMode) => {
    if (failureMode !== "504") jest.useFakeTimers();
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
        failureMode === "response_timeout"
          ? new Promise(() => {})
          : failureMode === "idle_timeout"
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
    if (failureMode !== "504") await jest.advanceTimersByTimeAsync(1100);
    await readInitial;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(isRetriableProviderStreamDisconnectError(failure)).toBe(true);
    const continuation = prepareProviderDisconnectContinuation([partial!], {
      allowCompletedTail: isProviderResponseTimeout(failure),
    });
    expect(isProviderResponseTimeout(failure)).toBe(
      failureMode === "response_timeout",
    );
    expect(continuation?.preservedCompletedToolCount).toBe(1);
    if (failureMode === "response_timeout") {
      expect(continuation?.removedPartCount).toBe(0);
      const decision = {
        userCancelled: false,
        unrecoverableVision: false,
        alreadyRetried: false,
        streamAborted: false,
        loopRecovery: false,
        hasCandidate: Boolean(continuation),
        modelEligible: Boolean(continuation),
      };
      expect(decideProviderRecovery(decision).attempt).toBe(true);
      expect(
        decideProviderRecovery({ ...decision, userCancelled: true }).reason,
      ).toBe("user_cancelled");
      expect(
        decideProviderRecovery({ ...decision, alreadyRetried: true }).reason,
      ).toBe("retry_budget_exhausted");
    }
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
