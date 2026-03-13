import { describe, it, expect } from "@jest/globals";
import type { UIMessage } from "ai";
import { pruneToolOutputs, pruneModelMessages } from "../prune-tool-outputs";

// Helper to create a UIMessage with tool parts
function makeAssistantMessage(
  parts: Array<Record<string, unknown>>,
  id = "msg-1",
): UIMessage {
  return { id, role: "assistant", parts: parts as any };
}

function makeUserMessage(text: string, id = "user-1"): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function makeToolPart(
  toolName: string,
  output: unknown,
  input: Record<string, unknown> = {},
  state = "output-available",
) {
  return {
    type: `tool-${toolName}`,
    toolCallId: `call-${Math.random().toString(36).slice(2, 8)}`,
    state,
    input,
    output,
  };
}

// Use minimumSavings=0 in most tests so we can test with small data.
// The minimum savings threshold is tested separately.
const NO_MIN = 0;

describe("pruneToolOutputs", () => {
  it("returns messages unchanged when total tool output tokens are within budget", () => {
    const messages: UIMessage[] = [
      makeUserMessage("hello"),
      makeAssistantMessage([
        { type: "text", text: "I'll run a command" },
        makeToolPart(
          "run_terminal_cmd",
          { stdout: "ok", exitCode: 0 },
          { command: "echo hi" },
        ),
      ]),
    ];

    const result = pruneToolOutputs(messages, 50_000, NO_MIN);

    expect(result.prunedCount).toBe(0);
    expect(result.tokensSaved).toBe(0);
    expect(result.messages).toBe(messages); // same reference
  });

  it("prunes oldest tool outputs first when over budget", () => {
    // Create a large output string that will exceed a small budget
    const largeOutput = "x".repeat(5000); // ~1250 tokens
    const smallOutput = "ok";

    const messages: UIMessage[] = [
      makeUserMessage("start"),
      makeAssistantMessage(
        [
          makeToolPart(
            "run_terminal_cmd",
            { stdout: largeOutput, exitCode: 0 },
            { command: "old-command" },
          ),
        ],
        "msg-old",
      ),
      makeAssistantMessage(
        [
          makeToolPart(
            "run_terminal_cmd",
            { stdout: smallOutput, exitCode: 0 },
            { command: "new-command" },
          ),
        ],
        "msg-new",
      ),
    ];

    // Budget small enough that the new output exhausts it,
    // so the old output gets pruned. "ok" output ≈ 10 tokens.
    const result = pruneToolOutputs(messages, 5, NO_MIN);

    expect(result.prunedCount).toBe(1);
    expect(result.tokensSaved).toBeGreaterThan(0);

    // The old message's tool output should be replaced with a placeholder
    const oldMsg = result.messages[1];
    const oldPart = oldMsg.parts[0] as any;
    expect(oldPart.output).toMatch(
      /^\[Terminal: ran 'old-command', exit code 0\]$/,
    );

    // The new message's tool output should be intact
    const newMsg = result.messages[2];
    const newPart = newMsg.parts[0] as any;
    expect(newPart.output).toEqual({ stdout: smallOutput, exitCode: 0 });
  });

  it("does not prune non-tool parts", () => {
    const messages: UIMessage[] = [
      makeUserMessage("a ".repeat(5000)), // large user message
      makeAssistantMessage([
        { type: "text", text: "b ".repeat(5000) }, // large text part
      ]),
    ];

    const result = pruneToolOutputs(messages, 100, NO_MIN);
    expect(result.prunedCount).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("does not prune tool parts that are not output-available", () => {
    const messages: UIMessage[] = [
      makeAssistantMessage([
        makeToolPart(
          "run_terminal_cmd",
          { stdout: "x".repeat(5000), exitCode: 0 },
          { command: "cmd" },
          "input-available",
        ),
      ]),
    ];

    const result = pruneToolOutputs(messages, 10, NO_MIN);
    expect(result.prunedCount).toBe(0);
  });

  it("does not prune tool parts with null output", () => {
    const messages: UIMessage[] = [
      makeAssistantMessage([
        makeToolPart("run_terminal_cmd", null, { command: "cmd" }),
      ]),
    ];

    const result = pruneToolOutputs(messages, 10, NO_MIN);
    expect(result.prunedCount).toBe(0);
  });

  it("generates correct placeholder for file read tool", () => {
    const fileContent = Array.from({ length: 100 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const messages: UIMessage[] = [
      makeAssistantMessage([
        makeToolPart(
          "file",
          { content: fileContent },
          { action: "read", path: "/src/index.ts" },
        ),
      ]),
      makeAssistantMessage(
        [
          makeToolPart(
            "run_terminal_cmd",
            { stdout: "recent", exitCode: 0 },
            { command: "echo" },
          ),
        ],
        "msg-new",
      ),
    ];

    const result = pruneToolOutputs(messages, 5, NO_MIN);

    // File part should be pruned with placeholder
    const filePart = result.messages[0].parts[0] as any;
    expect(filePart.output).toMatch(
      /\[File: read \/src\/index\.ts \(100 lines\)\]/,
    );
  });

  it("generates correct placeholder for file edit tool", () => {
    const messages: UIMessage[] = [
      makeAssistantMessage([
        makeToolPart(
          "file",
          { success: true, diff: "x".repeat(5000) },
          { action: "edit", path: "/src/app.ts" },
        ),
      ]),
      makeAssistantMessage(
        [
          makeToolPart(
            "run_terminal_cmd",
            { stdout: "recent", exitCode: 0 },
            { command: "echo" },
          ),
        ],
        "msg-new",
      ),
    ];

    const result = pruneToolOutputs(messages, 5, NO_MIN);
    const filePart = result.messages[0].parts[0] as any;
    expect(filePart.output).toBe("[File: edit /src/app.ts]");
  });

  it("generates correct placeholder for match tool", () => {
    const matches = Array.from({ length: 50 }, (_, i) => ({
      file: `/src/file${i % 8}.ts`,
      line: i,
      content: "x".repeat(100),
    }));

    const messages: UIMessage[] = [
      makeAssistantMessage([
        makeToolPart("match", matches, { pattern: "TODO" }),
      ]),
      makeAssistantMessage(
        [
          makeToolPart(
            "run_terminal_cmd",
            { stdout: "recent", exitCode: 0 },
            { command: "echo" },
          ),
        ],
        "msg-new",
      ),
    ];

    const result = pruneToolOutputs(messages, 5, NO_MIN);
    const matchPart = result.messages[0].parts[0] as any;
    expect(matchPart.output).toMatch(/\[Match: 50 results in/);
  });

  it("generates correct placeholder for web_search tool", () => {
    const messages: UIMessage[] = [
      makeAssistantMessage([
        makeToolPart(
          "web_search",
          {
            results: Array(10).fill({
              title: "r",
              url: "u",
              snippet: "s".repeat(500),
            }),
          },
          { query: "how to fix bug" },
        ),
      ]),
      makeAssistantMessage(
        [
          makeToolPart(
            "run_terminal_cmd",
            { stdout: "recent", exitCode: 0 },
            { command: "echo" },
          ),
        ],
        "msg-new",
      ),
    ];

    const result = pruneToolOutputs(messages, 5, NO_MIN);
    const searchPart = result.messages[0].parts[0] as any;
    expect(searchPart.output).toBe("[Search: 'how to fix bug']");
  });

  it("generates correct placeholder for unknown tools", () => {
    const messages: UIMessage[] = [
      makeAssistantMessage([
        makeToolPart("some_custom_tool", { data: "x".repeat(5000) }, {}),
      ]),
      makeAssistantMessage(
        [
          makeToolPart(
            "run_terminal_cmd",
            { stdout: "recent", exitCode: 0 },
            { command: "echo" },
          ),
        ],
        "msg-new",
      ),
    ];

    const result = pruneToolOutputs(messages, 5, NO_MIN);
    const part = result.messages[0].parts[0] as any;
    expect(part.output).toBe("[Tool: some_custom_tool completed]");
  });

  it("preserves input field on pruned parts", () => {
    const messages: UIMessage[] = [
      makeAssistantMessage([
        makeToolPart(
          "run_terminal_cmd",
          { stdout: "x".repeat(5000), exitCode: 0 },
          { command: "nmap -sV target" },
        ),
      ]),
      makeAssistantMessage(
        [
          makeToolPart(
            "run_terminal_cmd",
            { stdout: "recent", exitCode: 0 },
            { command: "echo" },
          ),
        ],
        "msg-new",
      ),
    ];

    const result = pruneToolOutputs(messages, 5, NO_MIN);
    const prunedPart = result.messages[0].parts[0] as any;
    expect(prunedPart.input).toEqual({ command: "nmap -sV target" });
  });

  it("does not mutate original messages", () => {
    const originalOutput = { stdout: "x".repeat(5000), exitCode: 0 };
    const messages: UIMessage[] = [
      makeAssistantMessage([
        makeToolPart("run_terminal_cmd", originalOutput, { command: "old" }),
      ]),
      makeAssistantMessage(
        [
          makeToolPart(
            "run_terminal_cmd",
            { stdout: "new", exitCode: 0 },
            { command: "new" },
          ),
        ],
        "msg-new",
      ),
    ];

    pruneToolOutputs(messages, 5, NO_MIN);

    // Original should be unchanged
    const origPart = messages[0].parts[0] as any;
    expect(origPart.output).toBe(originalOutput);
  });

  it("handles empty messages array", () => {
    const result = pruneToolOutputs([], 50_000, NO_MIN);
    expect(result.prunedCount).toBe(0);
    expect(result.messages).toEqual([]);
  });

  it("truncates long commands in placeholders", () => {
    const longCommand = "a".repeat(100);
    const messages: UIMessage[] = [
      makeAssistantMessage([
        makeToolPart(
          "run_terminal_cmd",
          { stdout: "x".repeat(5000), exitCode: 0 },
          { command: longCommand },
        ),
      ]),
      makeAssistantMessage(
        [
          makeToolPart(
            "run_terminal_cmd",
            { stdout: "recent", exitCode: 0 },
            { command: "echo" },
          ),
        ],
        "msg-new",
      ),
    ];

    const result = pruneToolOutputs(messages, 5, NO_MIN);
    const prunedPart = result.messages[0].parts[0] as any;
    expect(prunedPart.output).toContain("...");
    expect(prunedPart.output.length).toBeLessThan(120);
  });

  // --- Multiple tool parts in a single message ---

  it("prunes only old tool parts when multiple exist in one message", () => {
    const messages: UIMessage[] = [
      makeAssistantMessage(
        [
          { type: "text", text: "Running two commands" },
          makeToolPart(
            "run_terminal_cmd",
            { stdout: "x".repeat(5000), exitCode: 0 },
            { command: "first" },
          ),
          makeToolPart(
            "run_terminal_cmd",
            { stdout: "y".repeat(5000), exitCode: 1 },
            { command: "second" },
          ),
        ],
        "msg-old",
      ),
      makeAssistantMessage(
        [
          makeToolPart(
            "run_terminal_cmd",
            { stdout: "recent", exitCode: 0 },
            { command: "latest" },
          ),
        ],
        "msg-new",
      ),
    ];

    const result = pruneToolOutputs(messages, 5, NO_MIN);
    expect(result.prunedCount).toBe(2);

    // Text part should be untouched
    const textPart = result.messages[0].parts[0] as any;
    expect(textPart.type).toBe("text");
    expect(textPart.text).toBe("Running two commands");

    // Both tool parts in the old message should be pruned
    const firstPart = result.messages[0].parts[1] as any;
    const secondPart = result.messages[0].parts[2] as any;
    expect(firstPart.output).toMatch(/\[Terminal:/);
    expect(secondPart.output).toMatch(/\[Terminal:/);
  });

  // --- output-error parts ---

  it("prunes output-error tool parts too", () => {
    const messages: UIMessage[] = [
      makeAssistantMessage([
        makeToolPart(
          "run_terminal_cmd",
          { stderr: "x".repeat(5000), exitCode: 1 },
          { command: "failing" },
          "output-error",
        ),
      ]),
      makeAssistantMessage(
        [
          makeToolPart(
            "run_terminal_cmd",
            { stdout: "recent", exitCode: 0 },
            { command: "echo" },
          ),
        ],
        "msg-new",
      ),
    ];

    const result = pruneToolOutputs(messages, 5, NO_MIN);
    expect(result.prunedCount).toBe(1);
    const part = result.messages[0].parts[0] as any;
    expect(part.output).toMatch(/\[Terminal:/);
  });

  // --- Already-pruned detection ---

  it("skips already-pruned parts (string outputs)", () => {
    const messages: UIMessage[] = [
      makeAssistantMessage([
        // This was already pruned in a previous pass — output is a string placeholder
        makeToolPart("run_terminal_cmd", "[Terminal: ran 'old', exit code 0]", {
          command: "old",
        }),
      ]),
      makeAssistantMessage(
        [
          makeToolPart(
            "run_terminal_cmd",
            { stdout: "recent", exitCode: 0 },
            { command: "echo" },
          ),
        ],
        "msg-new",
      ),
    ];

    const result = pruneToolOutputs(messages, 5, NO_MIN);
    // The already-pruned part should not be counted or re-pruned
    expect(result.prunedCount).toBe(0);
  });

  // --- Protected tools ---

  it("never prunes protected tools (todo_write)", () => {
    const messages: UIMessage[] = [
      makeAssistantMessage([
        makeToolPart(
          "todo_write",
          { todos: Array(100).fill({ content: "task", status: "pending" }) },
          {},
        ),
      ]),
      makeAssistantMessage(
        [
          makeToolPart(
            "run_terminal_cmd",
            { stdout: "recent", exitCode: 0 },
            { command: "echo" },
          ),
        ],
        "msg-new",
      ),
    ];

    const result = pruneToolOutputs(messages, 5, NO_MIN);
    const todoPart = result.messages[0].parts[0] as any;
    // Output should be the original object, not a placeholder
    expect(todoPart.output).toEqual(
      expect.objectContaining({ todos: expect.any(Array) }),
    );
  });

  it("never prunes protected tools (create_note, list_notes, update_note, delete_note)", () => {
    const protectedTools = [
      "create_note",
      "list_notes",
      "update_note",
      "delete_note",
    ];

    for (const toolName of protectedTools) {
      const messages: UIMessage[] = [
        makeAssistantMessage([
          makeToolPart(toolName, { data: "x".repeat(5000) }, {}),
        ]),
        makeAssistantMessage(
          [
            makeToolPart(
              "run_terminal_cmd",
              { stdout: "recent", exitCode: 0 },
              { command: "echo" },
            ),
          ],
          "msg-new",
        ),
      ];

      const result = pruneToolOutputs(messages, 5, NO_MIN);
      const part = result.messages[0].parts[0] as any;
      expect(part.output).toEqual({ data: "x".repeat(5000) });
    }
  });

  // --- Minimum savings threshold ---

  it("skips pruning when token savings are below minimum threshold", () => {
    const messages: UIMessage[] = [
      makeAssistantMessage([
        // ~250 tokens of output — well below the 20K default minimum
        makeToolPart(
          "run_terminal_cmd",
          { stdout: "x".repeat(1000), exitCode: 0 },
          { command: "old" },
        ),
      ]),
      makeAssistantMessage(
        [
          makeToolPart(
            "run_terminal_cmd",
            { stdout: "recent", exitCode: 0 },
            { command: "new" },
          ),
        ],
        "msg-new",
      ),
    ];

    // Budget=5 would prune the old output, but minimum savings of 20K blocks it
    const result = pruneToolOutputs(messages, 5, 20_000);
    expect(result.prunedCount).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("prunes when token savings exceed minimum threshold", () => {
    // Use varied content that tokenizes to many tokens (repeated "x" compresses too well)
    const lines = Array.from(
      { length: 2000 },
      (_, i) =>
        `[line ${i}] Found vulnerability CVE-${2024 + (i % 5)}-${1000 + i} at endpoint /api/v${i % 3}/resource${i}`,
    ).join("\n");

    const messages: UIMessage[] = [
      makeAssistantMessage([
        makeToolPart(
          "run_terminal_cmd",
          { stdout: lines, exitCode: 0 },
          { command: "old" },
        ),
      ]),
      makeAssistantMessage(
        [
          makeToolPart(
            "run_terminal_cmd",
            { stdout: "recent", exitCode: 0 },
            { command: "new" },
          ),
        ],
        "msg-new",
      ),
    ];

    // Use a moderate minimum that the varied content will exceed
    const result = pruneToolOutputs(messages, 5, 1_000);
    expect(result.prunedCount).toBe(1);
    expect(result.tokensSaved).toBeGreaterThan(1_000);
  });

  // --- Diagnostic fields ---

  it("returns skipReason 'no-tool-outputs' when no tool parts exist", () => {
    const messages: UIMessage[] = [
      makeUserMessage("hello"),
      makeAssistantMessage([{ type: "text", text: "hi" }]),
    ];

    const result = pruneToolOutputs(messages, 100, NO_MIN);
    expect(result.skipReason).toBe("no-tool-outputs");
    expect(result.toolOutputCount).toBe(0);
    expect(result.totalToolOutputTokens).toBe(0);
  });

  it("returns skipReason 'within-budget' when all outputs fit in budget", () => {
    const messages: UIMessage[] = [
      makeAssistantMessage([
        makeToolPart(
          "run_terminal_cmd",
          { stdout: "ok", exitCode: 0 },
          { command: "echo" },
        ),
      ]),
    ];

    const result = pruneToolOutputs(messages, 50_000, NO_MIN);
    expect(result.skipReason).toBe("within-budget");
    expect(result.toolOutputCount).toBe(1);
    expect(result.totalToolOutputTokens).toBeGreaterThan(0);
  });

  it("returns skipReason 'below-minimum-savings' when savings are too small", () => {
    const messages: UIMessage[] = [
      makeAssistantMessage([
        makeToolPart(
          "run_terminal_cmd",
          { stdout: "x".repeat(1000), exitCode: 0 },
          { command: "old" },
        ),
      ]),
      makeAssistantMessage(
        [
          makeToolPart(
            "run_terminal_cmd",
            { stdout: "recent", exitCode: 0 },
            { command: "new" },
          ),
        ],
        "msg-new",
      ),
    ];

    const result = pruneToolOutputs(messages, 5, 20_000);
    expect(result.skipReason).toBe("below-minimum-savings");
    expect(result.toolOutputCount).toBe(2);
    expect(result.totalToolOutputTokens).toBeGreaterThan(0);
  });

  it("returns skipReason null and token totals when pruning occurs", () => {
    const largeOutput = "x".repeat(5000);
    const messages: UIMessage[] = [
      makeAssistantMessage([
        makeToolPart(
          "run_terminal_cmd",
          { stdout: largeOutput, exitCode: 0 },
          { command: "old" },
        ),
      ]),
      makeAssistantMessage(
        [
          makeToolPart(
            "run_terminal_cmd",
            { stdout: "recent", exitCode: 0 },
            { command: "new" },
          ),
        ],
        "msg-new",
      ),
    ];

    const result = pruneToolOutputs(messages, 5, NO_MIN);
    expect(result.skipReason).toBeNull();
    expect(result.prunedCount).toBe(1);
    expect(result.toolOutputCount).toBe(2);
    expect(result.totalToolOutputTokens).toBeGreaterThan(0);
    expect(result.tokensSaved).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// pruneModelMessages (CoreMessage-level pruning for agentic loop)
// ---------------------------------------------------------------------------

// Helpers for CoreMessage format
function makeAssistantModelMsg(
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }>,
) {
  return {
    role: "assistant",
    content: toolCalls.map((tc) => ({
      type: "tool-call",
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: tc.args,
    })),
  };
}

function makeToolModelMsg(
  results: Array<{ toolCallId: string; toolName: string; output: unknown }>,
) {
  return {
    role: "tool",
    content: results.map((r) => ({
      type: "tool-result",
      toolCallId: r.toolCallId,
      toolName: r.toolName,
      output: r.output,
    })),
  };
}

describe("pruneModelMessages", () => {
  it("returns messages unchanged when within budget", () => {
    const messages = [
      makeAssistantModelMsg([
        {
          toolCallId: "c1",
          toolName: "run_terminal_cmd",
          args: { command: "echo hi" },
        },
      ]),
      makeToolModelMsg([
        {
          toolCallId: "c1",
          toolName: "run_terminal_cmd",
          output: { stdout: "hi", exitCode: 0 },
        },
      ]),
    ];

    const result = pruneModelMessages(messages, 50_000, NO_MIN);
    expect(result.prunedCount).toBe(0);
    expect(result.skipReason).toBe("within-budget");
    expect(result.messages).toBe(messages);
  });

  it("prunes oldest tool results first when over budget", () => {
    const messages = [
      { role: "user", content: "start" },
      makeAssistantModelMsg([
        {
          toolCallId: "c1",
          toolName: "run_terminal_cmd",
          args: { command: "old-cmd" },
        },
      ]),
      makeToolModelMsg([
        {
          toolCallId: "c1",
          toolName: "run_terminal_cmd",
          output: { stdout: "x".repeat(5000), exitCode: 0 },
        },
      ]),
      makeAssistantModelMsg([
        {
          toolCallId: "c2",
          toolName: "run_terminal_cmd",
          args: { command: "new-cmd" },
        },
      ]),
      makeToolModelMsg([
        {
          toolCallId: "c2",
          toolName: "run_terminal_cmd",
          output: { stdout: "ok", exitCode: 0 },
        },
      ]),
    ];

    const result = pruneModelMessages(messages, 5, NO_MIN);
    expect(result.prunedCount).toBe(1);
    expect(result.tokensSaved).toBeGreaterThan(0);

    // Old tool result should be placeholder
    const oldToolMsg = result.messages[2] as any;
    expect(oldToolMsg.content[0].output).toMatch(
      /\[Terminal: ran 'old-cmd', exit code 0\]/,
    );

    // New tool result should be intact
    const newToolMsg = result.messages[4] as any;
    expect(newToolMsg.content[0].output).toEqual({ stdout: "ok", exitCode: 0 });
  });

  it("uses tool-call args for rich placeholders", () => {
    const messages = [
      makeAssistantModelMsg([
        {
          toolCallId: "c1",
          toolName: "file",
          args: { action: "read", path: "/src/index.ts" },
        },
      ]),
      makeToolModelMsg([
        {
          toolCallId: "c1",
          toolName: "file",
          output: {
            content: Array.from({ length: 50 }, (_, i) => `line ${i}`).join(
              "\n",
            ),
          },
        },
      ]),
      makeAssistantModelMsg([
        {
          toolCallId: "c2",
          toolName: "run_terminal_cmd",
          args: { command: "echo" },
        },
      ]),
      makeToolModelMsg([
        {
          toolCallId: "c2",
          toolName: "run_terminal_cmd",
          output: { stdout: "ok", exitCode: 0 },
        },
      ]),
    ];

    const result = pruneModelMessages(messages, 5, NO_MIN);
    const filePart = (result.messages[1] as any).content[0];
    expect(filePart.output).toMatch(
      /\[File: read \/src\/index\.ts \(50 lines\)\]/,
    );
  });

  it("does not prune protected tools", () => {
    const messages = [
      makeAssistantModelMsg([
        { toolCallId: "c1", toolName: "todo_write", args: {} },
      ]),
      makeToolModelMsg([
        {
          toolCallId: "c1",
          toolName: "todo_write",
          output: { todos: Array(100).fill({ content: "task" }) },
        },
      ]),
      makeAssistantModelMsg([
        {
          toolCallId: "c2",
          toolName: "run_terminal_cmd",
          args: { command: "echo" },
        },
      ]),
      makeToolModelMsg([
        {
          toolCallId: "c2",
          toolName: "run_terminal_cmd",
          output: { stdout: "ok", exitCode: 0 },
        },
      ]),
    ];

    const result = pruneModelMessages(messages, 5, NO_MIN);
    const todoPart = (result.messages[1] as any).content[0];
    expect(todoPart.output).toEqual(
      expect.objectContaining({ todos: expect.any(Array) }),
    );
  });

  it("skips already-pruned string outputs", () => {
    const messages = [
      makeAssistantModelMsg([
        {
          toolCallId: "c1",
          toolName: "run_terminal_cmd",
          args: { command: "old" },
        },
      ]),
      makeToolModelMsg([
        {
          toolCallId: "c1",
          toolName: "run_terminal_cmd",
          output: "[Terminal: ran 'old', exit code 0]",
        },
      ]),
      makeAssistantModelMsg([
        {
          toolCallId: "c2",
          toolName: "run_terminal_cmd",
          args: { command: "echo" },
        },
      ]),
      makeToolModelMsg([
        {
          toolCallId: "c2",
          toolName: "run_terminal_cmd",
          output: { stdout: "ok", exitCode: 0 },
        },
      ]),
    ];

    const result = pruneModelMessages(messages, 5, NO_MIN);
    expect(result.prunedCount).toBe(0);
  });

  it("does not mutate original messages", () => {
    const originalOutput = { stdout: "x".repeat(5000), exitCode: 0 };
    const messages = [
      makeAssistantModelMsg([
        {
          toolCallId: "c1",
          toolName: "run_terminal_cmd",
          args: { command: "old" },
        },
      ]),
      makeToolModelMsg([
        {
          toolCallId: "c1",
          toolName: "run_terminal_cmd",
          output: originalOutput,
        },
      ]),
      makeAssistantModelMsg([
        {
          toolCallId: "c2",
          toolName: "run_terminal_cmd",
          args: { command: "new" },
        },
      ]),
      makeToolModelMsg([
        {
          toolCallId: "c2",
          toolName: "run_terminal_cmd",
          output: { stdout: "ok", exitCode: 0 },
        },
      ]),
    ];

    pruneModelMessages(messages, 5, NO_MIN);
    const origPart = (messages[1] as any).content[0];
    expect(origPart.output).toBe(originalOutput);
  });

  it("skips non-tool messages", () => {
    const messages = [
      { role: "user", content: "a ".repeat(5000) },
      {
        role: "assistant",
        content: [{ type: "text", text: "b ".repeat(5000) }],
      },
    ];

    const result = pruneModelMessages(messages, 5, NO_MIN);
    expect(result.prunedCount).toBe(0);
    expect(result.skipReason).toBe("no-tool-outputs");
  });

  it("respects minimum savings threshold", () => {
    const messages = [
      makeAssistantModelMsg([
        {
          toolCallId: "c1",
          toolName: "run_terminal_cmd",
          args: { command: "old" },
        },
      ]),
      makeToolModelMsg([
        {
          toolCallId: "c1",
          toolName: "run_terminal_cmd",
          output: { stdout: "x".repeat(1000), exitCode: 0 },
        },
      ]),
      makeAssistantModelMsg([
        {
          toolCallId: "c2",
          toolName: "run_terminal_cmd",
          args: { command: "new" },
        },
      ]),
      makeToolModelMsg([
        {
          toolCallId: "c2",
          toolName: "run_terminal_cmd",
          output: { stdout: "ok", exitCode: 0 },
        },
      ]),
    ];

    const result = pruneModelMessages(messages, 5, 20_000);
    expect(result.prunedCount).toBe(0);
    expect(result.skipReason).toBe("below-minimum-savings");
  });

  it("returns diagnostic fields on pruning", () => {
    const messages = [
      makeAssistantModelMsg([
        {
          toolCallId: "c1",
          toolName: "run_terminal_cmd",
          args: { command: "old" },
        },
      ]),
      makeToolModelMsg([
        {
          toolCallId: "c1",
          toolName: "run_terminal_cmd",
          output: { stdout: "x".repeat(5000), exitCode: 0 },
        },
      ]),
      makeAssistantModelMsg([
        {
          toolCallId: "c2",
          toolName: "run_terminal_cmd",
          args: { command: "new" },
        },
      ]),
      makeToolModelMsg([
        {
          toolCallId: "c2",
          toolName: "run_terminal_cmd",
          output: { stdout: "ok", exitCode: 0 },
        },
      ]),
    ];

    const result = pruneModelMessages(messages, 5, NO_MIN);
    expect(result.skipReason).toBeNull();
    expect(result.prunedCount).toBe(1);
    expect(result.toolOutputCount).toBe(2);
    expect(result.totalToolOutputTokens).toBeGreaterThan(0);
    expect(result.tokensSaved).toBeGreaterThan(0);
  });
});
