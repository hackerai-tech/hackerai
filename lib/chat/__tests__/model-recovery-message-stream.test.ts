import { deserialize, serialize } from "node:v8";
import { WritableStream as NodeWritableStream } from "node:stream/web";
import { Chat } from "@ai-sdk/react";
import { convertToModelMessages, type UIMessageChunk } from "ai";
import type { ChatMessage } from "@/types";
import {
  arePersistedMessagesAtLeastAsComplete,
  normalizeStreamedRecoveryMessages,
} from "../message-reconciliation";

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

it("accepts the saved loop checkpoint and fallback after the real SDK carries primary parts forward", async () => {
  const chunks: UIMessageChunk[] = [
    { type: "start", messageId: "primary" },
    { type: "start-step" },
    { type: "text-start", id: "loop-text" },
    {
      type: "text-delta",
      id: "loop-text",
      delta: "Repeated preliminary text.",
    },
    { type: "text-end", id: "loop-text" },
    {
      type: "tool-input-available",
      toolCallId: "first-call",
      toolName: "file",
      input: { action: "read", path: "/tmp/first.txt" },
    },
    {
      type: "tool-output-available",
      toolCallId: "first-call",
      output: "first result",
    },
    { type: "finish-step" },
    { type: "finish", finishReason: "stop" },
    {
      type: "start",
      messageId: "fallback",
      messageMetadata: { recoverySourceMessageId: "primary" },
    },
    { type: "start-step" },
    {
      type: "tool-input-available",
      toolCallId: "second-call",
      toolName: "file",
      input: { action: "read", path: "/tmp/second.txt" },
    },
    {
      type: "tool-output-available",
      toolCallId: "second-call",
      output: "second result",
    },
    { type: "finish-step" },
    { type: "finish", finishReason: "stop" },
  ];
  const chat = new Chat<ChatMessage>({
    transport: {
      sendMessages: async () =>
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      reconnectToStream: async () => null,
    },
  });
  await chat.sendMessage({ text: "Read the two files." });
  expect(chat.status).toBe("ready");
  const primary = chat.messages.find((message) => message.id === "primary")!;
  const fallback = chat.messages.find((message) => message.id === "fallback")!;
  expect(fallback.parts.filter((part) => "toolCallId" in part)).toHaveLength(2);
  const displayed = normalizeStreamedRecoveryMessages(chat.messages);
  expect(
    displayed.flatMap((message) =>
      message.parts.flatMap((part) =>
        "toolCallId" in part ? [part.toolCallId] : [],
      ),
    ),
  ).toEqual(["first-call", "second-call"]);
  const persisted: ChatMessage[] = [
    chat.messages[0],
    {
      ...primary,
      parts: [
        ...primary.parts.filter(
          (part) => part.type === "step-start" || "toolCallId" in part,
        ),
        {
          type: "data-agent-loop-checkpoint",
          data: { continuationMessageId: "fallback" },
        },
      ],
    },
    { ...fallback, parts: fallback.parts.slice(primary.parts.length) },
  ];
  expect(arePersistedMessagesAtLeastAsComplete(chat.messages, persisted)).toBe(
    true,
  );
  expect(arePersistedMessagesAtLeastAsComplete(displayed, persisted)).toBe(
    true,
  );
  const modelMessages = await convertToModelMessages(persisted);
  expect(JSON.stringify(modelMessages)).not.toContain("continuationMessageId");
  expect(JSON.stringify(modelMessages)).toContain("first result");
  expect(JSON.stringify(modelMessages)).toContain("second result");
});
