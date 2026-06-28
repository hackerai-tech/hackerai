import {
  filterStandaloneProviderReasoningTagTextStream,
  stripStandaloneProviderReasoningTagTextMessage,
} from "../provider-reasoning-tags";

type TestChunk = {
  type: string;
  id?: string;
  delta?: string;
  [key: string]: unknown;
};

const collectStream = async (chunks: TestChunk[]): Promise<TestChunk[]> => {
  const stream = new ReadableStream<TestChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

  const reader =
    filterStandaloneProviderReasoningTagTextStream(stream).getReader();
  const result: TestChunk[] = [];

  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    result.push(next.value);
  }

  return result;
};

describe("provider reasoning tag cleanup", () => {
  it("drops standalone provider reasoning close tags from UI text chunks", async () => {
    await expect(
      collectStream([
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "</mm" },
        { type: "text-delta", id: "t1", delta: ":think>\n" },
        { type: "text-end", id: "t1" },
        { type: "tool-input-start", toolCallId: "call_1" },
      ]),
    ).resolves.toEqual([{ type: "tool-input-start", toolCallId: "call_1" }]);
  });

  it("preserves normal text that happens to mention a provider reasoning tag", async () => {
    const chunks = [
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "</think> done" },
      { type: "text-end", id: "t1" },
    ];

    await expect(collectStream(chunks)).resolves.toEqual(chunks);
  });

  it("removes tag-only assistant text parts without touching user text", () => {
    expect(
      stripStandaloneProviderReasoningTagTextMessage({
        id: "assistant",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "thinking", state: "done" },
          { type: "text", text: " </think>\n" },
          { type: "text", text: "visible answer" },
        ],
      }),
    ).toEqual({
      id: "assistant",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "thinking", state: "done" },
        { type: "text", text: "visible answer" },
      ],
    });

    expect(
      stripStandaloneProviderReasoningTagTextMessage({
        id: "user",
        role: "user",
        parts: [{ type: "text", text: "</mm:think>" }],
      }),
    ).toEqual({
      id: "user",
      role: "user",
      parts: [{ type: "text", text: "</mm:think>" }],
    });
  });
});
