import {
  createAgentToolSchemaSet,
  createFileToolSchema,
  createRunTerminalCmdToolSchema,
  createVulnerabilityReportToolInputSchema,
  runTerminalCmdTool,
} from "../schemas";

const getDescription = (value: unknown): string =>
  (value as { description: string }).description;

const getInputShape = (value: unknown): Record<string, unknown> =>
  (value as { inputSchema: { shape: Record<string, unknown> } }).inputSchema
    .shape;

describe("agent tool schema descriptions", () => {
  test("exposes structured findings only in persistent Agent modes", () => {
    expect(createAgentToolSchemaSet({ mode: "agent" })).toHaveProperty(
      "create_vulnerability_report",
    );
    expect(createAgentToolSchemaSet({ mode: "ask" })).not.toHaveProperty(
      "create_vulnerability_report",
    );
    expect(
      createAgentToolSchemaSet({ mode: "agent", isTemporary: true }),
    ).not.toHaveProperty("create_vulnerability_report");
  });

  test("uses the complete strict report schema in the model-facing contract", () => {
    const parsed = createVulnerabilityReportToolInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path[0])).toEqual(
        expect.arrayContaining([
          "title",
          "description",
          "impact",
          "target",
          "technical_analysis",
          "poc_description",
          "poc_script_code",
          "remediation_steps",
          "evidence",
          "assumptions",
          "fix_effort",
          "cvss_breakdown",
        ]),
      );
    }
  });

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
    expect(approvalGatedDescription).toContain(
      "HackerAI displays it in the approval prompt",
    );
    expect(approvalGatedDescription).toContain(
      "Prefer a stable safe prefix over copying the complete command",
    );
    expect(approvalGatedDescription).toContain(
      "Never provide prefix_rule for destructive commands",
    );
    expect(approvalGatedDescription).not.toContain(
      "Use command chaining and pipes for efficiency",
    );
    expect(approvalGatedDescription).not.toContain(
      "append ` | cat` to the command",
    );
    expect(getInputShape(approvalGatedTool)).toHaveProperty("justification");
    expect(getInputShape(approvalGatedTool)).toHaveProperty("prefix_rule");
    expect(getInputShape(approvalGatedTool).justification).toHaveProperty(
      "description",
      "A concise, user-facing reason shown in HackerAI's approval prompt. Explain the intended outcome rather than repeating the command.",
    );
    expect(getInputShape(approvalGatedTool).prefix_rule).toHaveProperty(
      "description",
      expect.stringContaining("separate argv elements"),
    );
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
