import { convertToModelMessages, type ToolSet, type UIMessage } from "ai";
import { createPromptSerializationTools } from "../prompt-serialization";

describe("createPromptSerializationTools", () => {
  it("serializes historical file view outputs without calling the live file tool", async () => {
    const liveFileToModelOutput = jest.fn(() => {
      throw new Error("live file serializer should not run for history");
    });
    const tools = createPromptSerializationTools({
      file: { toModelOutput: liveFileToModelOutput },
    } as unknown as ToolSet);
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-file",
            toolCallId: "call-1",
            state: "output-available",
            input: { action: "view", path: "/tmp/private.png" },
            output: {
              action: "view",
              content: "Viewing image file: private.png (image/png, 68 bytes).",
              path: "/tmp/private.png",
              filename: "private.png",
              mediaType: "image/png",
              sizeBytes: 68,
              kind: "image",
            },
          },
        ],
      },
    ] as UIMessage[];

    const result = await convertToModelMessages(messages, { tools });

    expect(liveFileToModelOutput).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "file",
            input: { action: "view", path: "/tmp/private.png" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "file",
            output: {
              type: "text",
              value: "Viewing image file: private.png (image/png, 68 bytes).",
            },
          },
        ],
      },
    ]);
  });

  it("preserves non-file tool serializers for provider-compatible history", async () => {
    const openUrlToModelOutput = jest.fn(({ output }) => ({
      type: "text" as const,
      value: `serialized:${String(output)}`,
    }));
    const tools = createPromptSerializationTools({
      open_url: { toModelOutput: openUrlToModelOutput },
    } as unknown as ToolSet);
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-open_url",
            toolCallId: "call-1",
            state: "output-available",
            input: { url: "https://example.com" },
            output: "tool result",
          },
        ],
      },
    ] as UIMessage[];

    const result = await convertToModelMessages(messages, { tools });

    expect(openUrlToModelOutput).toHaveBeenCalledWith({
      toolCallId: "call-1",
      input: { url: "https://example.com" },
      output: "tool result",
    });
    expect(result[1]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          output: { type: "text", value: "serialized:tool result" },
        },
      ],
    });
  });
});
