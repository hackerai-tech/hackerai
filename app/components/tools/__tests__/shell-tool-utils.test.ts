import {
  computeShellTerminalBlock,
  getTerminalFailureAction,
  isToolInputValidationError,
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
    expect(result.finalOutput).toBe(validationError);
    expect(result.sidebarContent).toMatchObject({
      command: "Invalid command",
      output: validationError,
      toolCallId: "call-empty",
    });
  });
});
