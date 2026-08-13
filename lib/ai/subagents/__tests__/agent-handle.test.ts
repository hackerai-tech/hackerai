import {
  SUBAGENT_HANDLE_SUFFIX_LENGTH,
  toSubagentHandle,
} from "@/lib/ai/subagents/agent-handle";

describe("toSubagentHandle", () => {
  it("projects a full internal ID to a compact model-facing handle", () => {
    expect(toSubagentHandle("sa_09041c08070448b5a5cee3c7c5454b66")).toBe(
      "sa_09041c08",
    );
    expect(SUBAGENT_HANDLE_SUFFIX_LENGTH).toBe(8);
  });

  it("preserves legacy short IDs and non-standard references", () => {
    expect(toSubagentHandle("sa_123")).toBe("sa_123");
    expect(toSubagentHandle("validator-1")).toBe("validator-1");
  });
});
