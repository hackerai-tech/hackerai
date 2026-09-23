import { deserialize, serialize } from "node:v8";
import { WritableStream as NodeWritableStream } from "node:stream/web";
import {
  convertToModelMessages,
  jsonSchema,
  readUIMessageStream,
  stepCountIs,
  streamText,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createPromptSerializationTools } from "@/lib/ai/tools/prompt-serialization";
import {
  ModelHistoryReplay,
  parseModelHistory,
  restoreModelHistory,
  sourceMessageDigests,
  prepareReplayAuthorization,
} from "../model-history";
import { stripOpenRouterReasoningMetadataFromMessages } from "../provider-metadata-sanitizer";

const originalClone = globalThis.structuredClone;
const originalWritable = globalThis.WritableStream;
beforeAll(() => {
  globalThis.structuredClone = <T>(value: T): T =>
    deserialize(serialize(value));
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: NodeWritableStream,
  });
});
afterAll(() => {
  globalThis.structuredClone = originalClone;
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: originalWritable,
  });
});

type StreamPart =
  Awaited<
    ReturnType<MockLanguageModelV3["doStream"]>
  >["stream"] extends ReadableStream<infer T>
    ? T
    : never;
const usage = {
  inputTokens: { total: 100, noCache: 10, cacheRead: 90, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

it("round-trips real SDK tool steps through persisted UI history while retaining model-only context", async () => {
  let calls = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      const parts: StreamPart[] =
        calls++ === 0
          ? [
              {
                type: "tool-call",
                toolCallId: "lookup-1",
                toolName: "lookup",
                input: "{}",
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage,
              },
            ]
          : [
              { type: "text-start", id: "answer" },
              { type: "text-delta", id: "answer", delta: "Finished lookup" },
              { type: "text-end", id: "answer" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage,
              },
            ];
      return {
        stream: new ReadableStream({
          start(controller) {
            parts.forEach((part) => controller.enqueue(part));
            controller.close();
          },
        }),
      };
    },
  });
  const tools = {
    lookup: {
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async () => ({ result: "evidence" }),
    },
  };
  const user: UIMessage = {
    id: "user",
    role: "user",
    parts: [{ type: "text", text: "Inspect this" }],
  };
  const source = await convertToModelMessages([user]);
  const replay = new ModelHistoryReplay();
  let sent: ModelMessage[] = [];
  let cursor = 0;
  const result = streamText({
    model,
    tools,
    messages: source,
    stopWhen: stepCountIs(3),
    prepareStep: ({ messages, stepNumber }) => {
      let projected = replay.project(messages);
      if (stepNumber === 1)
        projected = replay.append(projected, "notes", "New notes snapshot");
      projected = prepareReplayAuthorization(
        projected,
        sent,
        true,
        "model-deepseek-v4-flash-0731",
      );
      replay.commit(projected, messages.length);
      sent = structuredClone(projected);
      cursor = messages.length - source.length;
      return { messages: projected };
    },
  });
  let assistant: UIMessage | undefined;
  for await (const message of readUIMessageStream({
    stream: result.toUIMessageStream(),
    terminateOnError: true,
  }))
    assistant = message;
  const response = await result.response;
  const snapshot = parseModelHistory(
    JSON.stringify({
      version: 1,
      identity: "test",
      system: "system",
      source: sourceMessageDigests([...source, ...response.messages]),
      messages: [...sent, ...response.messages.slice(cursor)],
    }),
  );
  const next: UIMessage = {
    id: "next",
    role: "user",
    parts: [{ type: "text", text: "Continue" }],
  };
  const persisted = stripOpenRouterReasoningMetadataFromMessages([
    user,
    assistant!,
    next,
  ]);
  const reconstructed = await convertToModelMessages(persisted, {
    tools: createPromptSerializationTools(tools),
  });
  const restored = restoreModelHistory(
    snapshot,
    "test",
    reconstructed,
    reconstructed,
  );
  expect(restored).toBeDefined();
  expect(
    restored?.filter(
      (message) =>
        typeof message.content === "string" &&
        message.content.startsWith("New notes snapshot"),
    ),
  ).toHaveLength(1);
  expect(restored?.slice(0, snapshot!.messages.length)).toEqual(
    snapshot!.messages,
  );
  expect(model.doStreamCalls).toHaveLength(2);
});
