import React, { useState, useEffect } from "react";
import { UIMessage } from "@ai-sdk/react";
import { CommandResult } from "@e2b/code-interpreter";
import ToolBlock from "@/components/ui/tool-block";
import { Terminal } from "lucide-react";
import { useGlobalState } from "../../contexts/GlobalState";
import { useProcessContext } from "../../contexts/ProcessContext";
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
  const { registerProcess, isProcessRunning, isProcessKilling, killProcess } = useProcessContext();
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

  // Register background processes for tracking
  useEffect(() => {
    if (terminalInput?.is_background && pid && terminalInput?.command) {
      registerProcess(pid, terminalInput.command);
    }
  }, [pid, terminalInput?.is_background, terminalInput?.command, registerProcess]);

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

  const handleKillProcess = async () => {
    if (!pid) return;
    await killProcess(pid);
  };

  // Format command display
  const commandDisplay = terminalInput?.command || "";

  // Determine status badge based on process running state from context
  const processRunning = pid ? isProcessRunning(pid) : false;
  const processKilling = pid ? isProcessKilling(pid) : false;
  const statusBadge = terminalInput?.is_background && pid && processRunning
    ? ("running" as const)
    : null;

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
          onKill={statusBadge === "running" ? handleKillProcess : undefined}
          isKilling={processKilling}
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
          onKill={statusBadge === "running" ? handleKillProcess : undefined}
          isKilling={processKilling}
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
          onKill={statusBadge === "running" ? handleKillProcess : undefined}
          isKilling={processKilling}
        />
      );
    default:
      return null;
  }
};
