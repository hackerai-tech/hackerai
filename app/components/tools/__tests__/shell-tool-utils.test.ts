import {
  computeShellTerminalBlock,
  getTerminalExecutionPhase,
  getTerminalFailureAction,
  isToolInputValidationError,
  stripAgentOnlyTerminalGuidance,
  type ShellToolInput,
  type ShellToolOutput,
} from "../shell-tool-utils";
import { extractAllSidebarContent } from "@/lib/utils/sidebar-utils";
import { describeCloudUnavailability } from "@/lib/ai/tools/utils/cloud-unavailability-message";
import type { SidebarTerminal } from "@/types";

describe("terminal shell tool display helpers", () => {
  const completedCommand = (shellOutput: ShellToolOutput) =>
    computeShellTerminalBlock({
      isShellTool: false,
      shellInput: undefined,
      shellOutput,
      isExecuting: false,
      hasResult: true,
      toolCallId: "call-exit",
      legacyCommand: 'sh -c "exit 7"',
    });

  it.each([
    { result: { exitCode: 7, error: "exit status 7" } },
    { result: { exitCode: 7, output: "partial output" } },
    { result: { exited: { exitCode: 7 }, output: "partial output" } },
    { exitCode: 7, output: "partial output" },
  ])("shows a structured nonzero exit in the completed header", (output) => {
    const result = completedCommand(output);

    expect(result.blockAction(false)).toBe("Exited with code 7");
    expect(result.blockTarget).toBe('sh -c "exit 7"');
    expect(result.sidebarContent?.command).toBe('sh -c "exit 7"');
  });

  it.each([0, null, undefined, NaN, Infinity, 1.5])(
    "does not infer a failed process from an absent or invalid exit code %s",
    (exitCode) => {
      const result = completedCommand({
        result: { exitCode, output: "exit status 7" },
      });

      expect(result.blockAction(false)).toBe("Executed");
    },
  );

  it("keeps failed commands identifiable when a shell brief is present", () => {
    const result = computeShellTerminalBlock({
      isShellTool: true,
      shellInput: { action: "exec", command: "false", brief: "Check target" },
      shellOutput: { result: { exitCode: 1, output: "partial output" } },
      isExecuting: false,
      hasResult: true,
      toolCallId: "call-brief",
    });

    expect(result.blockAction(false)).toBe("Exited with code 1");
    expect(result.blockTarget).toBe("false");
    expect(result.finalOutput).toBe("partial output");
    expect(result.blockAction(true)).toBe("Executing");
  });

  it("does not label a running command as failed before a result arrives", () => {
    const result = computeShellTerminalBlock({
      isShellTool: true,
      shellInput: { action: "exec", command: "false" },
      shellOutput: { result: { exitCode: 7 } },
      isExecuting: true,
      hasResult: false,
      toolCallId: "call-running",
    });

    expect(result.blockAction(true)).toBe("Executing");
  });

  it("keeps intentional session termination labeled as killed", () => {
    const result = computeShellTerminalBlock({
      isShellTool: true,
      shellInput: { action: "kill", session: "qa-session" },
      shellOutput: { result: { exited: { exitCode: 130 } } },
      isExecuting: false,
      hasResult: true,
      toolCallId: "call-kill",
    });

    expect(result.blockAction(false)).toBe("Killed");
  });

  const validationError =
    "Invalid input for tool run_terminal_cmd: Type validation failed: Value: {}.";

  it("keeps review separate from process execution", () => {
    expect(
      getTerminalExecutionPhase({
        toolState: "input-available",
        autoReviewStatus: "reviewing",
      }),
    ).toBe("reviewing");
    expect(
      getTerminalExecutionPhase({
        toolState: "input-available",
        autoReviewStatus: "approved",
      }),
    ).toBe("executing");
    expect(
      getTerminalExecutionPhase({
        toolState: "approval-requested",
        autoReviewStatus: "needs_approval",
      }),
    ).toBe("awaiting_approval");
    expect(
      getTerminalExecutionPhase({
        toolState: "output-available",
        autoReviewStatus: "reviewing",
      }),
    ).toBe("completed");
  });

  it("classifies tool input validation errors as invalid commands", () => {
    expect(isToolInputValidationError(validationError)).toBe(true);
    expect(getTerminalFailureAction(validationError)).toBe("Invalid command");
  });

  it("classifies non-validation terminal errors as command failures", () => {
    expect(
      getTerminalFailureAction("Sandbox is probably not running anymore"),
    ).toBe("Command failed");
  });

  it("keeps invalid empty terminal calls visible and sidebar-readable", () => {
    const result = computeShellTerminalBlock({
      isShellTool: false,
      shellInput: undefined,
      shellOutput: undefined,
      errorText: validationError,
      streamingOutput: "",
      isExecuting: false,
      hasResult: false,
      toolCallId: "call-empty",
      legacyCommand: undefined,
      executionPhase: "failed",
    });

    expect(result.blockAction(false)).toBe("Invalid command");
    expect(result.blockTarget).toBe("Invalid command");
    expect(result.finalOutput).toBe(
      "Some tool parameters did not match the required format.",
    );
    expect(result.sidebarContent).toMatchObject({
      command: "Invalid command",
      output: "Some tool parameters did not match the required format.",
      toolCallId: "call-empty",
      executionPhase: "failed",
    });
    expect(JSON.stringify(result.sidebarContent)).not.toContain("Value: {}.");
  });

  it("keeps non-validation empty terminal failures label-consistent", () => {
    const errorText = "Sandbox is probably not running anymore";
    const result = computeShellTerminalBlock({
      isShellTool: false,
      shellInput: undefined,
      shellOutput: undefined,
      errorText,
      streamingOutput: "",
      isExecuting: false,
      hasResult: false,
      toolCallId: "call-failed",
      legacyCommand: undefined,
    });

    expect(result.blockAction(false)).toBe("Command failed");
    expect(result.blockTarget).toBe("Command failed");
    expect(result.sidebarContent).toMatchObject({
      command: "Command failed",
      output: errorText,
    });
  });

  it.each([
    [
      "Command output paused after 120 seconds. Command continues in terminal session f7f6fc79 (PID: 93771). Use interact_terminal_session with this exact session ID to wait, view, or kill it.",
      "Command output paused after 120 seconds. Command continues in terminal session f7f6fc79 (PID: 93771).",
    ],
    [
      "Command output paused after 120 seconds. Command continues in the background with PID: 93771, but no reusable terminal session was created. Do not derive a session ID from the PID or call interact_terminal_session for this command.",
      "Command output paused after 120 seconds. Command continues in the background with PID: 93771, but no reusable terminal session was created.",
    ],
    [
      "Detached background process started with PID: 93771. No reusable terminal session was created; do not pass this PID to interact_terminal_session.\n",
      "Detached background process started with PID: 93771. No reusable terminal session was created.\n",
    ],
    [
      "Session f7f6fc79 not found. Only use the exact session ID returned by run_terminal_cmd; a PID is not a session ID and must never be converted into one.",
      "Session f7f6fc79 not found.",
    ],
    [
      "Session f7f6fc79 has exited (exitCode=0). Use action=view to read final output, or start a new session via run_terminal_cmd.",
      "Session f7f6fc79 has exited (exitCode=0).",
    ],
    [
      "Session f7f6fc79 belongs to a non-interactive command and does not accept input. Use action=wait, view, or kill.",
      "Session f7f6fc79 belongs to a non-interactive command and does not accept input.",
    ],
    [
      "Interactive terminal sessions are unavailable on this local connection. Use non-interactive terminal commands instead.",
      "Interactive terminal sessions are unavailable on this local connection.",
    ],
    [
      'action=send requires `input`. To submit just Enter (e.g. to terminate a Python multi-line block or accept a default prompt), pass input="Enter" or input="\\n".',
      "Terminal input was missing.",
    ],
    ["action=wait requires `session`.", "Terminal session was not specified."],
    [
      "Input exceeds MAX_INPUT_BYTES_PER_SEND=65536 (got 65537).",
      "Terminal input is too large.",
    ],
    [
      "Sandbox is unavailable after repeated health check failures. Do NOT retry any terminal or sandbox commands. Inform the user that the sandbox could not be reached and suggest they wait a moment and try again, or delete the sandbox in Settings > Data Controls. If the issue persists, contact HackerAI support.",
      "Sandbox is unavailable after repeated health check failures. Try again in a moment, or delete the sandbox in Settings > Data Controls. If the issue persists, contact HackerAI support.",
    ],
    [
      describeCloudUnavailability({ kind: "cooldown", retryAfterMs: 59_200 }),
      "The cloud workspace is temporarily unavailable. Your workspace is preserved. The next sandbox tool call after about 60 seconds will try to reconnect automatically.",
    ],
    [
      describeCloudUnavailability({
        kind: "disabled",
        reason: "workspace_recovery_required",
      }),
      "Your cloud workspace needs recovery before it can be used, so cloud tools are unavailable for the rest of this request. Your workspace is preserved.",
    ],
    [
      "Sandbox recreation failed. The sandbox environment is not responding. Another attempt may be made but the sandbox will be marked unavailable after repeated failures.",
      "Sandbox recreation failed. The sandbox environment is not responding.",
    ],
    [
      "Failed to kill session f7f6fc79: connection closed. The session was retained so cleanup can be retried.",
      "Failed to kill session f7f6fc79: connection closed.",
    ],
  ])(
    "removes agent-only terminal guidance from sidebar output",
    (raw, shown) => {
      expect(stripAgentOnlyTerminalGuidance(raw)).toBe(shown);
    },
  );

  it("keeps agent guidance in the raw tool output while hiding it in the sidebar", () => {
    const rawOutput =
      "Command output paused after 120 seconds. Command continues in terminal session f7f6fc79 (PID: 93771). Use interact_terminal_session with this exact session ID to wait, view, or kill it.";
    const result = computeShellTerminalBlock({
      isShellTool: false,
      shellInput: undefined,
      shellOutput: { result: { output: rawOutput } },
      streamingOutput: "",
      isExecuting: false,
      hasResult: true,
      toolCallId: "call-timeout",
      legacyCommand: "npm test",
    });

    expect(result.finalOutput).toBe(rawOutput);
    expect(result.sidebarContent?.output).toBe(
      "Command output paused after 120 seconds. Command continues in terminal session f7f6fc79 (PID: 93771).",
    );
  });

  it("does not remove matching prose from the middle of command output", () => {
    const commandOutput =
      "Use action=wait, view, or kill.\nThis line came from the command.";

    expect(stripAgentOnlyTerminalGuidance(commandOutput)).toBe(commandOutput);
  });
});

describe("terminal display text source", () => {
  const BRIEF = "agent-browser open the sign-in page";
  const OPEN = "agent-browser open https://example.org";
  type Part = {
    type: string;
    toolCallId: string;
    state: string;
    input: Record<string, unknown>;
    output?: unknown;
  };
  const message = (part: Part) => ({
    id: "assistant",
    role: "assistant",
    parts: [part],
  });

  /** Text and tag from the live producer and the tool-handler producer. */
  const produced = (part: Part) => {
    const pick = (item?: SidebarTerminal | null) =>
      item ? { command: item.command, source: item.commandSource } : null;
    const live = extractAllSidebarContent(
      [message(part)] as Parameters<typeof extractAllSidebarContent>[0],
      true,
    ).find((item) => "toolCallId" in item) as SidebarTerminal | undefined;
    const isShellTool = part.type === "tool-shell";
    const handler =
      part.type === "tool-interact_terminal_session"
        ? undefined
        : computeShellTerminalBlock({
            isShellTool,
            shellInput: isShellTool
              ? (part.input as ShellToolInput)
              : undefined,
            shellOutput: undefined,
            isExecuting: false,
            hasResult: true,
            toolCallId: part.toolCallId,
            legacyCommand: isShellTool
              ? undefined
              : (part.input.command as string | undefined),
          }).sidebarContent;
    return { live: pick(live), handler: pick(handler) };
  };
  const tagged = (command: string, source?: string) => ({ command, source });
  const shell = (input: Record<string, unknown>): Part => ({
    type: "tool-shell",
    toolCallId: "call",
    state: "output-available",
    input,
    output: { output: "" },
  });
  const legacy = (type: string, input: Record<string, unknown>): Part => ({
    type: `tool-${type}`,
    toolCallId: "call",
    state: "output-available",
    input,
    output: { result: { output: "" } },
  });

  it.each([
    [
      "brief-only exec",
      shell({ action: "exec", brief: BRIEF }),
      tagged(BRIEF, "brief"),
      tagged(BRIEF, "brief"),
    ],
    [
      "real open with a brief",
      shell({ action: "exec", command: OPEN, brief: "Open the site" }),
      tagged(OPEN, "command"),
      tagged(OPEN, "command"),
    ],
    [
      // The live producer shows the command; the handler shows the brief.
      "interactive view with both fields",
      shell({ action: "view", session: "s1", command: OPEN, brief: BRIEF }),
      tagged(OPEN, "command"),
      tagged(BRIEF, "interactive_brief"),
    ],
    [
      // Equal text still records the field each producer chose.
      "interactive view whose brief equals its command",
      shell({ action: "view", session: "s1", command: OPEN, brief: OPEN }),
      tagged(OPEN, "command"),
      tagged(OPEN, "interactive_brief"),
    ],
    [
      "interactive brief-only send",
      shell({ action: "send", session: "s1", input: "q\n", brief: BRIEF }),
      tagged(BRIEF, "interactive_brief"),
      tagged(BRIEF, "interactive_brief"),
    ],
    [
      "interactive label",
      shell({ action: "kill", session: "s1" }),
      null,
      tagged("kill"),
    ],
    [
      "legacy open",
      legacy("run_terminal_cmd", { command: OPEN }),
      tagged(OPEN, "command"),
      tagged(OPEN, "command"),
    ],
    [
      "legacy empty-command brief",
      legacy("run_terminal_cmd", { command: "", brief: BRIEF }),
      tagged(BRIEF, "brief"),
      null,
    ],
    [
      "legacy interactive brief",
      legacy("interact_terminal_session", {
        action: "send",
        session: "s1",
        input: "q\n",
        brief: BRIEF,
      }),
      tagged(BRIEF, "interactive_brief"),
      null,
    ],
    [
      // Formatted keystrokes read like a command but are not one.
      "legacy formatted send input",
      legacy("interact_terminal_session", {
        action: "send",
        session: "s1",
        input: `${OPEN}\n`,
      }),
      tagged(OPEN),
      null,
    ],
  ] as Array<
    [
      string,
      Part,
      ReturnType<typeof tagged> | null,
      ReturnType<typeof tagged> | null,
    ]
  >)(
    "tags the %s at the producer that chose it",
    (_name, part, live, handler) => {
      expect(produced(part)).toEqual({ live, handler });
    },
  );
});
