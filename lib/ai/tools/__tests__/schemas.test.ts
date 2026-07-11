import {
  createFileToolSchema,
  createRunTerminalCmdToolSchema,
  runTerminalCmdTool,
} from "../schemas";

const getDescription = (value: unknown): string =>
  (value as { description: string }).description;

const getInputShape = (value: unknown): Record<string, unknown> =>
  (value as { inputSchema: { shape: Record<string, unknown> } }).inputSchema
    .shape;

describe("agent tool schema descriptions", () => {
  test("terminal command approval wording is mode-specific", () => {
    const fullAccessDescription = getDescription(runTerminalCmdTool);
    expect(fullAccessDescription).not.toContain("ask the user to approve it");
    expect(fullAccessDescription).toContain(
      "Use command chaining and pipes for efficiency",
    );
    expect(fullAccessDescription).toContain("append ` | cat` to the command");

    const approvalGatedTool = createRunTerminalCmdToolSchema({
      approvalGated: true,
    });
    const approvalGatedDescription = getDescription(approvalGatedTool);

    expect(approvalGatedDescription).toContain(
      "The platform will pause execution after you call this tool and ask the user to approve it",
    );
    expect(approvalGatedDescription).toContain(
      "Prefer one static command per tool call",
    );
    expect(approvalGatedDescription).not.toContain(
      "Use command chaining and pipes for efficiency",
    );
    expect(approvalGatedDescription).not.toContain(
      "append ` | cat` to the command",
    );
    expect(getInputShape(approvalGatedTool)).toHaveProperty("justification");
    expect(getInputShape(approvalGatedTool)).toHaveProperty("prefix_rule");
    expect(getInputShape(runTerminalCmdTool)).not.toHaveProperty(
      "justification",
    );
    expect(getInputShape(runTerminalCmdTool)).not.toHaveProperty("prefix_rule");
  });

  test("file approval wording is only included for approval-gated schemas", () => {
    const fullAccessTool = createFileToolSchema({ supportsView: true });
    const approvalGatedTool = createFileToolSchema({
      supportsView: true,
      approvalGated: true,
    });

    expect(getDescription(fullAccessTool)).not.toContain("approval-gated");
    expect(getDescription(approvalGatedTool)).toContain(
      "Write, append, and edit actions are approval-gated.",
    );
  });
});
