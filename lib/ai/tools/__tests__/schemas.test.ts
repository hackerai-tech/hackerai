import {
  createAgentToolSchemaSet,
  createFileToolSchema,
  createGetTerminalFilesToolSchema,
  createInteractTerminalSessionToolSchema,
  createOpenUrlToolSchema,
  createRunTerminalCmdToolSchema,
  createWebSearchToolSchema,
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
    expect(fullAccessDescription).toContain(
      "Process running with session ID X",
    );
    expect(fullAccessDescription).toContain(
      "a detached PID is not a reusable terminal session",
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
    expect(getDescription(fullAccessTool)).toContain(
      "automatically routes subsequent Agent steps to a vision-capable model",
    );
  });

  test("always exposes image view in the Agent schema catalog", () => {
    const agentTools = createAgentToolSchemaSet();
    const fileInputShape = getInputShape(agentTools.file);
    const actionSchema = fileInputShape.action as {
      safeParse: (input: unknown) => { success: boolean };
    };

    expect(actionSchema.safeParse("view").success).toBe(true);
    expect(createAgentToolSchemaSet({ mode: "ask" })).not.toHaveProperty(
      "file",
    );
  });

  test("passes the active model into every brief-bearing tool schema", () => {
    const createBriefBearingTools = (modelName: string) => ({
      run_terminal_cmd: createRunTerminalCmdToolSchema({ modelName }),
      interact_terminal_session: createInteractTerminalSessionToolSchema({
        modelName,
      }),
      get_terminal_files: createGetTerminalFilesToolSchema({ modelName }),
      file: createFileToolSchema({ supportsView: true, modelName }),
      web_search: createWebSearchToolSchema({ modelName }),
      open_url: createOpenUrlToolSchema({ modelName }),
    });
    const deepSeekTools = createBriefBearingTools("model-deepseek-v4-pro-0813");
    const otherTools = createBriefBearingTools("model-grok-4.6");

    for (const toolName of [
      "run_terminal_cmd",
      "interact_terminal_session",
      "get_terminal_files",
      "file",
      "web_search",
      "open_url",
    ] as const) {
      const deepSeekBrief = getInputShape(deepSeekTools[toolName]).brief as {
        description: string;
      };
      const otherBrief = getInputShape(otherTools[toolName]).brief as {
        description: string;
      };

      expect(deepSeekBrief.description).toContain("English only");
      expect(otherBrief.description).not.toContain("English only");
    }
  });
});
