import { getActionText } from "../computer-sidebar-utils";
import { computeShellTerminalBlock } from "../tools/shell-tool-utils";

describe("terminal Computer sidebar labels", () => {
  const terminal = {
    command: "wafw00f https://hackerone.com",
    output: "",
    isExecuting: false,
    toolCallId: "call-1",
  };

  it("shows the same failed exit in the chat and Computer headers", () => {
    const block = computeShellTerminalBlock({
      isShellTool: false,
      shellInput: undefined,
      shellOutput: { result: { exitCode: 7, error: "exit status 7" } },
      isExecuting: false,
      hasResult: true,
      toolCallId: "call-exit7",
      legacyCommand: 'sh -c "exit 7"',
      executionPhase: "completed",
    });

    expect(block.blockAction(false)).toBe("Exited with code 7");
    expect(block.sidebarContent).not.toBeNull();
    expect(getActionText(block.sidebarContent!)).toBe("Exited with code 7");
    expect(block.sidebarContent?.output).toBe("exit status 7");
  });

  it("keeps successful, running, and intentionally killed commands distinct", () => {
    expect(getActionText({ ...terminal, exitCode: 0 })).toBe("Executed");
    expect(getActionText({ ...terminal, isExecuting: true, exitCode: 7 })).toBe(
      "Executing",
    );
    expect(
      getActionText({ ...terminal, shellAction: "kill", exitCode: 130 }),
    ).toBe("Killed");
    expect(getActionText({ ...terminal, executionPhase: "failed" })).toBe(
      "Command failed",
    );
  });

  it("labels review without implying the command is executing", () => {
    expect(getActionText({ ...terminal, executionPhase: "reviewing" })).toBe(
      "Reviewing",
    );
    expect(
      getActionText({ ...terminal, executionPhase: "awaiting_approval" }),
    ).toBe("Awaiting approval");
  });
});
