import { getActionText } from "../computer-sidebar-utils";
import {
  computeShellTerminalBlock,
  getTerminalExecutionPhase,
} from "../tools/shell-tool-utils";
import { extractSidebarContentFromMessage } from "@/lib/utils/sidebar-utils";
import { ABORTED_TOOL_ERROR_TEXT } from "@/lib/chat/tool-abort-utils";

describe("terminal Computer sidebar labels", () => {
  const terminal = {
    command: "wafw00f https://hackerone.com",
    output: "",
    isExecuting: false,
    toolCallId: "call-1",
  };

  it.each([
    "tool-run_terminal_cmd",
    "tool-shell",
    "tool-interact_terminal_session",
  ])(
    "keeps a user-stopped %s distinct from failure live and after reload",
    (type) => {
      const input =
        type === "tool-interact_terminal_session"
          ? { action: "wait", session: "qa-session" }
          : type === "tool-shell"
            ? { action: "exec", command: "sleep 30" }
            : { command: "sleep 30" };
      const part = {
        type,
        input,
        state: "output-error",
        errorText: ABORTED_TOOL_ERROR_TEXT,
        toolCallId: "call-stopped",
      };
      const block = computeShellTerminalBlock({
        isShellTool: input.action !== undefined,
        shellInput: input,
        legacyCommand: input.command,
        shellOutput: undefined,
        errorText: part.errorText,
        isExecuting: false,
        hasResult: false,
        toolCallId: part.toolCallId,
        executionPhase: getTerminalExecutionPhase({
          toolState: part.state,
          errorText: part.errorText,
        }),
      });
      const [restored] = extractSidebarContentFromMessage({
        role: "assistant",
        parts: [part],
      });

      expect(getActionText(block.sidebarContent!)).toBe("Stopped command");
      expect(getActionText(restored)).toBe("Stopped command");
    },
  );

  it("does not classify a terminal failure as a user stop", () => {
    const [failed] = extractSidebarContentFromMessage({
      role: "assistant",
      parts: [
        {
          type: "tool-run_terminal_cmd",
          toolCallId: "call-failed",
          input: { command: "sleep 30" },
          state: "output-error",
          errorText: "Sandbox connection failed",
        },
      ],
    });

    expect(getActionText(failed)).toBe("Command failed");
    expect(getActionText({ ...terminal, exitCode: 130 })).toBe(
      "Exited with code 130",
    );
  });

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
