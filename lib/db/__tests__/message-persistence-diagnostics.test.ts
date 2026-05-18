import { describe, expect, it } from "@jest/globals";
import { getMessagePersistenceDiagnostics } from "../message-persistence-diagnostics";

describe("getMessagePersistenceDiagnostics", () => {
  it("summarizes message parts without exposing part content", () => {
    const diagnostics = getMessagePersistenceDiagnostics([
      { type: "text", text: "hello secret text" } as any,
      { type: "reasoning", text: "private chain" } as any,
      {
        type: "tool-run_terminal_cmd",
        state: "output-available",
        input: { command: "cat secret.txt" },
        output: { result: { output: "secret output" } },
      } as any,
      { type: "data-terminal", data: { terminal: "secret stream" } } as any,
    ]);

    expect(diagnostics.part_count).toBe(4);
    expect(diagnostics.part_types).toEqual({
      text: 1,
      reasoning: 1,
      "tool-run_terminal_cmd": 1,
      "data-terminal": 1,
    });
    expect(diagnostics.tool_part_count).toBe(1);
    expect(diagnostics.data_part_count).toBe(1);
    expect(diagnostics.text_chars).toBe("hello secret text".length);
    expect(diagnostics.reasoning_chars).toBe("private chain".length);

    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("hello secret text");
    expect(serialized).not.toContain("private chain");
    expect(serialized).not.toContain("secret output");
    expect(serialized).not.toContain("secret stream");
  });
});
