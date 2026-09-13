import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import {
  getProviderToolCallDiagnostics,
  splitProviderToolCallBatches,
} from "../provider-tool-call-batches";
import { compactMessageForStorage } from "../compaction/prune-tool-outputs";

function history(count: number): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        { type: "text", text: "private notes" },
        ...Array.from({ length: count }, (_, i) => ({
          type: "tool-call" as const,
          toolCallId: `call-${i}`,
          toolName: "file",
          input: { path: "private path" },
        })),
      ],
    },
    {
      role: "tool",
      content: Array.from({ length: count }, (_, i) => ({
        type: "tool-result" as const,
        toolCallId: `call-${i}`,
        toolName: "file",
        output: { type: "text" as const, value: `private output ${i}` },
      })),
    },
    { role: "user", content: "continue" },
  ];
}

describe("provider tool-call batches", () => {
  it("repairs a legacy 148-call turn without dropping or repeating any calls/results", () => {
    const input = history(148);
    const original = JSON.parse(JSON.stringify(input));
    const repaired = splitProviderToolCallBatches(input);
    expect(repaired.splitCount).toBe(1);
    expect(repaired.messages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
      "tool",
      "user",
    ]);
    expect(getProviderToolCallDiagnostics(repaired.messages)).toEqual({
      max_tool_calls_per_assistant: 128,
      unmatched_tool_call_count: 0,
      unmatched_tool_result_count: 0,
      duplicate_tool_call_count: 0,
    });
    for (const role of ["assistant", "tool"]) {
      const parts = (messages: ModelMessage[]) =>
        messages.filter((m) => m.role === role).flatMap((m) => m.content);
      expect(parts(repaired.messages)).toEqual(parts(input));
    }
    expect(input).toEqual(original);
    expect(splitProviderToolCallBatches(repaired.messages).messages).toBe(
      repaired.messages,
    );
  });

  it("preserves valid batches and multiple tool-result message metadata", () => {
    const small = history(128);
    expect(splitProviderToolCallBatches(small).messages).toBe(small);
    const input = history(129);
    const tool = input[1] as Extract<ModelMessage, { role: "tool" }>;
    input.splice(
      1,
      1,
      {
        ...tool,
        content: tool.content.slice(0, 100),
        providerOptions: { test: { marker: "a" } },
      },
      {
        ...tool,
        content: tool.content.slice(100),
        providerOptions: { test: { marker: "b" } },
      },
    );
    const output = splitProviderToolCallBatches(input).messages;
    expect(
      output.filter((m) => m.role === "tool").map((m) => m.providerOptions),
    ).toEqual([
      { test: { marker: "a" } },
      { test: { marker: "b" } },
      { test: { marker: "b" } },
    ]);
    expect(
      getProviderToolCallDiagnostics(output).unmatched_tool_result_count,
    ).toBe(0);
  });

  it.each(["missing", "duplicate", "unmatched"])(
    "does not guess how to repair %s results",
    (problem) => {
      const input = history(129);
      const tool = input[1] as Extract<ModelMessage, { role: "tool" }>;
      if (problem === "missing") tool.content.pop();
      if (problem === "duplicate") tool.content[128] = tool.content[0];
      if (problem === "unmatched")
        tool.content[128] = {
          ...tool.content[128],
          toolCallId: "orphan",
        } as (typeof tool.content)[number];
      expect(splitProviderToolCallBatches(input)).toEqual({
        messages: input,
        splitCount: 0,
      });
    },
  );

  it("reports invalid pairing using counts only", () => {
    const input = history(2);
    const tool = input[1] as Extract<ModelMessage, { role: "tool" }>;
    tool.content.pop();
    tool.content.push({
      type: "tool-result",
      toolCallId: "private-orphan",
      toolName: "file",
      output: { type: "text", value: "private output" },
    });
    const diagnostics = getProviderToolCallDiagnostics(input);
    expect(diagnostics).toMatchObject({
      unmatched_tool_call_count: 1,
      unmatched_tool_result_count: 1,
    });
    expect(JSON.stringify(diagnostics)).not.toContain("private");
  });

  it("preserves step boundaries through storage compaction and real SDK serialization", async () => {
    const message: UIMessage = {
      id: "assistant",
      role: "assistant",
      parts: Array.from({ length: 148 }, (_, i) => [
        { type: "step-start" as const },
        {
          type: "tool-file" as const,
          toolCallId: `call-${i}`,
          state: "output-available" as const,
          input: {},
          output: "ok",
        },
      ]).flat(),
    };
    message.parts.unshift({
      type: "data-summarization",
      data: { text: "x".repeat(100_000) },
    });
    const compaction = compactMessageForStorage(message, {
      softLimitBytes: 50_000,
    });
    expect(compaction.compacted).toBe(true);
    const stored = compaction.message;
    const serialized = await convertToModelMessages([stored]);
    expect(serialized.filter((m) => m.role === "assistant")).toHaveLength(148);
    expect(getProviderToolCallDiagnostics(serialized)).toMatchObject({
      max_tool_calls_per_assistant: 1,
      unmatched_tool_call_count: 0,
      unmatched_tool_result_count: 0,
    });
  });
});
