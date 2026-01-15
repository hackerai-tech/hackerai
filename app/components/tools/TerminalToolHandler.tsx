import React, { useEffect, useMemo } from "react";
import { UIMessage } from "@ai-sdk/react";
import { CommandResult } from "@e2b/code-interpreter";
import ToolBlock from "@/components/ui/tool-block";
import { Terminal } from "lucide-react";
import { useGlobalState } from "../../contexts/GlobalState";
import type { ChatStatus, SidebarTerminal, SidebarContent } from "@/types/chat";
import { isSidebarTerminal } from "@/types/chat";

interface TerminalToolHandlerProps {
  message: UIMessage;
  part: any;
  status: ChatStatus;
  // Optional: pass openSidebar to make handler context-agnostic
  externalOpenSidebar?: (content: SidebarContent) => void;
}

export const TerminalToolHandler = ({
  message,
  part,
  status,
  externalOpenSidebar,
}: TerminalToolHandlerProps) => {
  const globalState = useGlobalState();
  // Use external openSidebar if provided, otherwise use from GlobalState
  const openSidebar = externalOpenSidebar ?? globalState.openSidebar;
  const { sidebarOpen, sidebarContent, updateSidebarContent } = globalState;
  const { toolCallId, state, input, output, errorText } = part;
  const terminalInput = input as {
    command: string;
    is_background: boolean;
  };
  const terminalOutput = output as {
    result: CommandResult & { output?: string };
  };

  // Memoize streaming output computation
  const streamingOutput = useMemo(() => {
    const terminalDataParts = message.parts.filter(
      (p) =>
        p.type === "data-terminal" &&
        (p as any).data?.toolCallId === toolCallId,
    );
    return terminalDataParts
      .map((p) => (p as any).data?.terminal || "")
      .join("");
  }, [message.parts, toolCallId]);

  // Memoize final output computation
  const finalOutput = useMemo(() => {
    // Prefer new combined output format, fall back to legacy stdout+stderr for old messages
    const newFormatOutput = terminalOutput?.result?.output ?? "";
    const stdout = terminalOutput?.result?.stdout ?? "";
    const stderr = terminalOutput?.result?.stderr ?? "";
    const legacyOutput = stdout + stderr;

    return (
      newFormatOutput ||
      legacyOutput ||
      streamingOutput ||
      (terminalOutput?.result?.error ?? "") ||
      errorText ||
      ""
    );
  }, [terminalOutput, streamingOutput, errorText]);

  const isExecuting = state === "input-available" && status === "streaming";

  const handleOpenInSidebar = () => {
    if (!terminalInput?.command) return;

    const sidebarTerminal: SidebarTerminal = {
      command: terminalInput.command,
      output: finalOutput,
      isExecuting,
      isBackground: terminalInput.is_background,
      toolCallId: toolCallId,
    };

    openSidebar(sidebarTerminal);
  };

  // Track if this sidebar is currently active (only for GlobalState mode)
  const isSidebarActive =
    !externalOpenSidebar &&
    sidebarOpen &&
    sidebarContent &&
    isSidebarTerminal(sidebarContent) &&
    sidebarContent.toolCallId === toolCallId;

  // Update sidebar content in real-time if it's currently open for this tool call
  // Only applies when using GlobalState (not external openSidebar)
  useEffect(() => {
    if (!isSidebarActive || externalOpenSidebar) return;

    updateSidebarContent({
      output: finalOutput,
      isExecuting,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSidebarActive, finalOutput, isExecuting, externalOpenSidebar]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleOpenInSidebar();
    }
  };

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
          action="Executing"
          target={terminalInput?.command || ""}
          isShimmer={status === "streaming"}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      );
    case "output-available":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Terminal />}
          action="Executing"
          target={terminalInput?.command || ""}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      );
    case "output-error":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Terminal />}
          action="Executing"
          target={terminalInput?.command || ""}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      );
    default:
      return null;
  }
};
