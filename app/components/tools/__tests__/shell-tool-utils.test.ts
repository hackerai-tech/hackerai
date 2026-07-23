import {
  computeShellTerminalBlock,
  getTerminalFailureAction,
  isToolInputValidationError,
  stripAgentOnlyTerminalGuidance,
} from "../shell-tool-utils";

describe("terminal shell tool display helpers", () => {
  const validationError =
    "Invalid input for tool run_terminal_cmd: Type validation failed: Value: {}.";

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
