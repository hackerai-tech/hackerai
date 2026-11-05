import {
  streamText,
  stepCountIs,
  tool,
  type LanguageModel,
  type UIMessage,
} from "ai";
import { WritableStream } from "node:stream/web";
import { z } from "zod";

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

// Exercise the installed SDK, including UI persistence callbacks and compaction.
// Serialized request bodies are diagnostic copies, not the next step's history.
async function runToolLoop(requestBody: boolean) {
  let calls = 0;
  const promptSizes: number[] = [];
  const completedStepBodies: unknown[] = [];
  let savedMessage: UIMessage | undefined;
  const model: LanguageModel = {
    specificationVersion: "v3",
    provider: "test",
    modelId: "test",
    supportedUrls: {},
    doGenerate: jest.fn(),
    doStream: async ({ prompt }) => {
      const body = JSON.stringify(prompt);
      promptSizes.push(body.length);
      const step = calls++;
      const last = step === 11;
      return {
        request: { body },
        stream: new ReadableStream({
          start(controller) {
            if (last) {
              controller.enqueue({ type: "text-start", id: "answer" });
              controller.enqueue({
                type: "text-delta",
                id: "answer",
                delta: "Finished",
              });
              controller.enqueue({ type: "text-end", id: "answer" });
            } else {
              controller.enqueue({
                type: "tool-call",
                toolCallId: `scan-${step}`,
                toolName: "scan",
                input: "{}",
              });
            }
            controller.enqueue({
              type: "finish",
              finishReason: {
                unified: last ? "stop" : "tool-calls",
                raw: last ? "stop" : "tool-calls",
              },
              usage: {
                inputTokens: {
                  total: 100,
                  noCache: 100,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 10, text: 10, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      };
    },
  };
  const result = streamText({
    model,
    experimental_include: { requestBody },
    prompt: "Initial context " + "x".repeat(256 * 1024),
    tools: {
      scan: tool({
        inputSchema: z.object({}),
        execute: async () => "scan result",
      }),
    },
    stopWhen: stepCountIs(12),
    prepareStep: ({ stepNumber }) =>
      stepNumber >= 4
        ? {
            messages: [
              { role: "user", content: "Compacted context. Continue." },
            ],
          }
        : undefined,
    onStepFinish: ({ request }) => {
      completedStepBodies.push(request.body);
    },
    maxRetries: 0,
  });
  const reader = result
    .toUIMessageStream({
      generateMessageId: () => "assistant",
      onFinish: ({ responseMessage }) => {
        savedMessage = responseMessage;
      },
    })
    .getReader();
  while (!(await reader.read()).done) {
    /* Drain the same UI stream used by Agent. */
  }
  const steps = await result.steps;
  return {
    promptSizes,
    completedStepBodies,
    retainedBytes: steps.reduce(
      (sum, step) =>
        sum +
        (typeof step.request.body === "string" ? step.request.body.length : 0),
      0,
    ),
    messages: (await result.response).messages,
    usage: await result.totalUsage,
    savedMessage,
    text: await result.text,
  };
}

it("drops serialized step requests without losing tool history, usage, or the saved UI response", async () => {
  const baseline = await runToolLoop(true);
  const bounded = await runToolLoop(false);
  // Compaction shrinks subsequent requests, but does not free earlier request copies by default.
  expect(baseline.retainedBytes).toBeGreaterThan(1024 * 1024);
  expect(bounded.retainedBytes).toBe(0);
  expect(bounded.completedStepBodies).toEqual(Array(12).fill(undefined));
  expect(bounded.promptSizes).toEqual(baseline.promptSizes);
  expect(bounded.promptSizes[4]).toBeLessThan(1024);
  expect(bounded.messages).toEqual(baseline.messages);
  expect(bounded.usage).toEqual(baseline.usage);
  expect(bounded.savedMessage).toEqual(baseline.savedMessage);
  expect(
    bounded.savedMessage?.parts.filter((part) => part.type === "tool-scan"),
  ).toHaveLength(11);
  expect(bounded.text).toBe("Finished");
});
