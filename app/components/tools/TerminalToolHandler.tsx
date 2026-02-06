import React, { memo, useEffect, useMemo, useCallback } from "react";
import { UIMessage } from "@ai-sdk/react";
import { CommandResult } from "@e2b/code-interpreter";
import ToolBlock from "@/components/ui/tool-block";
import { Terminal } from "lucide-react";
import { useGlobalState } from "../../contexts/GlobalState";
import type { ChatStatus, SidebarTerminal } from "@/types/chat";
import { isSidebarTerminal } from "@/types/chat";

interface TerminalToolHandlerProps {
  message: UIMessage;
  part: any;
  status: ChatStatus;
  /** Pre-computed streaming output for this toolCallId (avoids filtering message.parts in every instance) */
  precomputedStreamingOutput?: string;
}

// Custom comparison to avoid re-renders when tool state hasn't changed
function areTerminalPropsEqual(
  prev: TerminalToolHandlerProps,
  next: TerminalToolHandlerProps,
): boolean {
  if (prev.status !== next.status) return false;
  if (prev.part.state !== next.part.state) return false;
  if (prev.part.toolCallId !== next.part.toolCallId) return false;
  if (prev.part.output !== next.part.output) return false;
  // Compare message.parts length for streaming output updates
  if (prev.message.parts.length !== next.message.parts.length) return false;
  if (prev.precomputedStreamingOutput !== next.precomputedStreamingOutput)
    return false;
  return true;
}

export const TerminalToolHandler = memo(function TerminalToolHandler({
  message,
  part,
  status,
  precomputedStreamingOutput,
}: TerminalToolHandlerProps) {
  const { openSidebar, sidebarOpen, sidebarContent, updateSidebarContent } =
    useGlobalState();
  const { toolCallId, state, input, output, errorText } = part;
  const terminalInput = input as {
    command: string;
    is_background: boolean;
  };
  const terminalOutput = output as {
    result: CommandResult & { output?: string };
  };

  // Memoize streaming output: use pre-computed value when passed, else derive from message.parts
  const effectiveToolCallId = (part as any).data?.toolCallId ?? toolCallId;
  const streamingOutput = useMemo(() => {
    if (precomputedStreamingOutput !== undefined)
      return precomputedStreamingOutput;
    const terminalDataParts = message.parts.filter(
      (p) =>
        p.type === "data-terminal" &&
        (p as any).data?.toolCallId === effectiveToolCallId,
    );
    return terminalDataParts
      .map((p) => (p as any).data?.terminal || "")
      .join("");
  }, [precomputedStreamingOutput, message.parts, effectiveToolCallId]);

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

  const handleOpenInSidebar = useCallback(() => {
    if (!terminalInput?.command) return;

    const sidebarTerminal: SidebarTerminal = {
      command: terminalInput.command,
      output: finalOutput,
      isExecuting,
      isBackground: terminalInput.is_background,
      toolCallId: toolCallId,
    };

    openSidebar(sidebarTerminal);
  }, [
    terminalInput?.command,
    terminalInput?.is_background,
    finalOutput,
    isExecuting,
    toolCallId,
    openSidebar,
  ]);

  // Track if this sidebar is currently active
  const isSidebarActive =
    sidebarOpen &&
    sidebarContent &&
    isSidebarTerminal(sidebarContent) &&
    sidebarContent.toolCallId === toolCallId;

  // Update sidebar content in real-time if it's currently open for this tool call
  useEffect(() => {
    if (!isSidebarActive) return;

    updateSidebarContent({
      output: finalOutput,
      isExecuting,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSidebarActive, finalOutput, isExecuting]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleOpenInSidebar();
      }
    },
    [handleOpenInSidebar],
  );

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
          action="Executed"
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
          action="Executed"
          target={terminalInput?.command || ""}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      );
    default:
      return null;
  }
}, areTerminalPropsEqual);
