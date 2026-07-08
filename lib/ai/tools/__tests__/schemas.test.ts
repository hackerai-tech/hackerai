import {
  createFileToolSchema,
  createRunTerminalCmdToolSchema,
  runTerminalCmdTool,
} from "../schemas";

const getDescription = (value: unknown): string =>
  (value as { description: string }).description;

describe("agent tool schema descriptions", () => {
  test("terminal command approval wording is mode-specific", () => {
    expect(getDescription(runTerminalCmdTool)).not.toContain(
      "ask the user to approve it",
    );

    const approvalGatedTool = createRunTerminalCmdToolSchema({
      approvalGated: true,
    });

    expect(getDescription(approvalGatedTool)).toContain(
      "The platform will pause execution after you call this tool and ask the user to approve it",
    );
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
