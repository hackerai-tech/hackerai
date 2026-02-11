import React, { memo, useEffect, useMemo, useCallback } from "react";
import { UIMessage } from "@ai-sdk/react";
import ToolBlock from "@/components/ui/tool-block";
import { Terminal } from "lucide-react";
import { useGlobalState } from "../../contexts/GlobalState";
import type { ChatStatus, SidebarTerminal } from "@/types/chat";
import { isSidebarTerminal } from "@/types/chat";
import {
  getShellActionLabel,
  getShellDisplayCommand,
  getShellDisplayTarget,
  getShellOutput,
  type ShellToolOutput,
} from "./shell-tool-utils";

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

  // Support both legacy run_terminal_cmd and new shell tool input shapes
  const isShellTool = part.type === "tool-shell" || input?.action !== undefined;
  const terminalInput = isShellTool
    ? { command: getShellDisplayCommand(input), is_background: false }
    : (input as { command: string; is_background: boolean });
  const terminalOutput = output as ShellToolOutput;

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
  const finalOutput = useMemo(
    () => getShellOutput(terminalOutput, { streamingOutput, errorText }),
    [terminalOutput, streamingOutput, errorText],
  );

  const isExecuting = state === "input-available" && status === "streaming";

  const displayCommand = isShellTool
    ? getShellDisplayCommand(input)
    : terminalInput?.command || "";
  const displayTarget = isShellTool
    ? getShellDisplayTarget(input)
    : displayCommand;

  const shellAction = isShellTool
    ? (input as { action?: string })?.action
    : undefined;
  const shellPid = (input as { pid?: number })?.pid ?? terminalOutput?.pid;
  const shellSession =
    (input as { session?: string })?.session ?? terminalOutput?.session;
  const getActionLabel = (isActive: boolean) =>
    getShellActionLabel({
      isShellTool,
      action: shellAction,
      pid: shellPid,
      session: shellSession,
      isActive,
    });

  const handleOpenInSidebar = useCallback(() => {
    if (!displayCommand) return;

    const sidebarTerminal: SidebarTerminal = {
      command: displayCommand,
      output: finalOutput,
      isExecuting,
      isBackground: terminalInput.is_background,
      toolCallId: toolCallId,
      shellAction,
      pid: shellPid,
      session: shellSession,
      input: (input as { input?: string })?.input,
    };

    openSidebar(sidebarTerminal);
  }, [
    displayCommand,
    terminalInput?.is_background,
    finalOutput,
    isExecuting,
    toolCallId,
    shellAction,
    shellPid,
    shellSession,
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
      command: displayCommand,
      output: finalOutput,
      isExecuting,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSidebarActive, displayCommand, finalOutput, isExecuting]);

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
    case "input-streaming": {
      if (status !== "streaming") return null;
      // For non-exec shell actions (wait, send, kill), use the action-specific
      // label instead of "Generating command" which only applies to exec
      if (isShellTool && shellAction && shellAction !== "exec") {
        return (
          <ToolBlock
            key={toolCallId}
            icon={<Terminal />}
            action={getActionLabel(true)}
            target={displayTarget || undefined}
            isShimmer={true}
          />
        );
      }
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Terminal />}
          action="Generating command"
          isShimmer={true}
        />
      );
    }
    case "input-available":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Terminal />}
          action={getActionLabel(status === "streaming")}
          target={displayTarget}
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
          action={getActionLabel(false)}
          target={displayTarget}
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
          action={getActionLabel(false)}
          target={displayTarget}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      );
    default:
      return null;
  }
}, areTerminalPropsEqual);
