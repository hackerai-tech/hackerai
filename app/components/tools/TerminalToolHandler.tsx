import React from "react";
import { UIMessage } from "@ai-sdk/react";
import { CommandResult } from "@e2b/code-interpreter";
import ToolBlock from "@/components/ui/tool-block";
import { Terminal } from "lucide-react";
import { useGlobalState } from "../../contexts/GlobalState";
import { useTerminalProcess } from "../../contexts/useTerminalProcess";
import type { ChatStatus, SidebarTerminal } from "@/types/chat";

interface TerminalToolHandlerProps {
  message: UIMessage;
  part: any;
  status: ChatStatus;
}

export const TerminalToolHandler = ({
  message,
  part,
  status,
}: TerminalToolHandlerProps) => {
  const { openSidebar } = useGlobalState();
  const { toolCallId, state, input, output, errorText } = part;
  const terminalInput = input as {
    command: string;
    is_background: boolean;
  };
  const terminalOutput = output as {
    result: CommandResult & { output?: string; pid?: number };
  };

  // Extract PID from background process output
  const pid = terminalInput?.is_background && terminalOutput?.result?.pid
    ? terminalOutput.result.pid
    : null;

  // Handle terminal process state (registration, status, kill)
  const { isKilling, handleKill, statusBadge } = useTerminalProcess({
    isBackground: terminalInput?.is_background,
    pid: pid,
    command: terminalInput?.command,
  });

  const handleOpenInSidebar = () => {
    if (!terminalInput?.command) return;

    // Get terminal data parts for streaming output (for manual clicks)
    const terminalDataParts = message.parts.filter(
      (p) =>
        p.type === "data-terminal" &&
        (p as any).data?.toolCallId === toolCallId,
    );
    const streamingOutput = terminalDataParts
      .map((p) => (p as any).data?.terminal || "")
      .join("");

    // Prefer new combined output format, fall back to legacy stdout+stderr for old messages
    const newFormatOutput = terminalOutput?.result?.output ?? "";
    const stdout = terminalOutput?.result?.stdout ?? "";
    const stderr = terminalOutput?.result?.stderr ?? "";
    const legacyOutput = stdout + stderr;

    const finalOutput =
      newFormatOutput ||
      legacyOutput ||
      streamingOutput ||
      (terminalOutput?.result?.error ?? "") ||
      errorText ||
      "";

    const sidebarTerminal: SidebarTerminal = {
      command: terminalInput.command,
      output: finalOutput,
      isExecuting: state === "input-available" && status === "streaming",
      isBackground: terminalInput.is_background,
      pid: terminalOutput?.result?.pid ?? null,
      toolCallId: toolCallId,
    };

    openSidebar(sidebarTerminal);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleOpenInSidebar();
    }
  };

  // Format command display
  const commandDisplay = terminalInput?.command || "";

  switch (state) {
    case "input-streaming":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={<Terminal />}
          action="Generating command"
          isShimmer={true}
        />
      ) : null;
    case "input-available":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Terminal />}
          action={status === "streaming" ? "Executing" : "Executed"}
          target={commandDisplay}
          isShimmer={status === "streaming"}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
          statusBadge={statusBadge}
          onKill={statusBadge === "running" ? handleKill : undefined}
          isKilling={isKilling}
        />
      );
    case "output-available":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Terminal />}
          action="Executed"
          target={commandDisplay}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
          statusBadge={statusBadge}
          onKill={statusBadge === "running" ? handleKill : undefined}
          isKilling={isKilling}
        />
      );
    case "output-error":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Terminal />}
          action="Executed"
          target={commandDisplay}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
          statusBadge={statusBadge}
          onKill={statusBadge === "running" ? handleKill : undefined}
          isKilling={isKilling}
        />
      );
    default:
      return null;
  }
};
