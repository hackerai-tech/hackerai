import React, { memo, useMemo } from "react";
import { UIMessage } from "@ai-sdk/react";
import ToolBlock from "@/components/ui/tool-block";
import { Terminal } from "lucide-react";
import type { ChatStatus, SidebarTerminal } from "@/types/chat";
import { isSidebarTerminal } from "@/types/chat";
import { useToolSidebar } from "../../hooks/useToolSidebar";
import {
  getShellActionLabel,
  getShellDisplayCommand,
  getShellDisplayTarget,
  getShellOutput,
  getStreamingTerminalOutput,
  isInteractiveShellAction,
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
  const { toolCallId, state, input, output, errorText } = part;

  // Support both legacy run_terminal_cmd and new shell tool input shapes
  const isShellTool = part.type === "tool-shell" || input?.action !== undefined;
  const terminalInput = isShellTool
    ? {
        command: getShellDisplayCommand(input),
        is_background: false,
        interactive: false,
      }
    : (input as {
        command: string;
        is_background: boolean;
        interactive?: boolean;
      });
  const terminalOutput = output as ShellToolOutput;

  // Memoize streaming output: use pre-computed value when passed, else derive from message.parts
  const effectiveToolCallId = (part as any).data?.toolCallId ?? toolCallId;
  const streamingOutput = useMemo(() => {
    if (precomputedStreamingOutput !== undefined)
      return precomputedStreamingOutput;
    return getStreamingTerminalOutput(message.parts, effectiveToolCallId);
  }, [precomputedStreamingOutput, message.parts, effectiveToolCallId]);

  // Memoize final output computation.
  // sessionSnapshot is cleaned via xterm headless - use it when available.
  // During streaming, show raw streamingOutput for responsiveness.
  // On completion, prefer the cleaned sessionSnapshot.
  const shellAction = isShellTool
    ? (input as { action?: string })?.action
    : undefined;
  const isInteractive = isInteractiveShellAction(shellAction);
  // Extract sessionSnapshot regardless of action type - if it exists, it's clean
  const sessionSnapshot = terminalOutput?.result?.sessionSnapshot;
  const hasResult = state === "output-available";
  const finalOutput = useMemo(
    () =>
      // On completion, prefer cleaned sessionSnapshot if available
      sessionSnapshot && hasResult
        ? sessionSnapshot
        : // During streaming for interactive sessions, show live output
          isInteractive && streamingOutput
          ? streamingOutput
          : // Fallback to sessionSnapshot if no streaming
            sessionSnapshot
            ? sessionSnapshot
            : getShellOutput(terminalOutput, { streamingOutput, errorText }),
    [
      sessionSnapshot,
      hasResult,
      isInteractive,
      terminalOutput,
      streamingOutput,
      errorText,
    ],
  );

  const isExecuting = state === "input-available" && status === "streaming";

  const isInteractiveAction = isInteractiveShellAction(shellAction);
  const isKillAction = shellAction === "kill";
  const displayCommand = isShellTool
    ? getShellDisplayCommand(input) ||
      (isInteractiveAction && !isKillAction ? shellAction || "" : "")
    : terminalInput?.command || "";
  // For kill, the session id flows into the target slot so the inline
  // block reads "Killed 7ed0b48d" — matches the action+target pattern of
  // other shell ToolBlocks instead of leaving an empty target.
  const shellSessionForTarget =
    (input as { session?: string })?.session ?? terminalOutput?.session;
  const displayTarget = isKillAction
    ? shellSessionForTarget
      ? shellSessionForTarget.slice(0, 8)
      : ""
    : isShellTool
      ? getShellDisplayTarget(input) || displayCommand
      : displayCommand;

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
      interactive: !isShellTool ? terminalInput?.interactive : undefined,
      isBackground: !isShellTool ? terminalInput?.is_background : undefined,
      compact: true,
    });

  // Prefer rawSnapshot when tool is complete (has final state), streaming during execution
  const rawSnapshot = terminalOutput?.result?.rawSnapshot;
  const effectiveRawBytes =
    hasResult && rawSnapshot
      ? rawSnapshot
      : streamingOutput || rawSnapshot || undefined;

  const sidebarContent = useMemo((): SidebarTerminal | null => {
    if (!displayCommand && !isInteractiveAction) return null;
    return {
      command: isInteractiveAction ? displayTarget : displayCommand,
      output: finalOutput,
      isExecuting,
      isBackground: terminalInput?.is_background,
      isInteractive: !isShellTool ? terminalInput?.interactive : undefined,
      toolCallId,
      shellAction,
      pid: shellPid,
      session: shellSession,
      input: (input as { input?: string })?.input,
      rawBytes: effectiveRawBytes,
    };
  }, [
    displayCommand,
    displayTarget,
    finalOutput,
    isExecuting,
    isInteractiveAction,
    isShellTool,
    terminalInput?.is_background,
    terminalInput?.interactive,
    toolCallId,
    shellAction,
    shellPid,
    shellSession,
    input,
    effectiveRawBytes,
  ]);

  const { handleOpenInSidebar, handleKeyDown } = useToolSidebar({
    toolCallId,
    content: sidebarContent,
    typeGuard: isSidebarTerminal,
  });

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
          isClickable={!isKillAction}
          onClick={isKillAction ? undefined : handleOpenInSidebar}
          onKeyDown={isKillAction ? undefined : handleKeyDown}
        />
      );
    case "output-available":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Terminal />}
          action={getActionLabel(false)}
          target={displayTarget}
          isClickable={!isKillAction}
          onClick={isKillAction ? undefined : handleOpenInSidebar}
          onKeyDown={isKillAction ? undefined : handleKeyDown}
        />
      );
    case "output-error":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Terminal />}
          action={getActionLabel(false)}
          target={displayTarget}
          isClickable={!isKillAction}
          onClick={isKillAction ? undefined : handleOpenInSidebar}
          onKeyDown={isKillAction ? undefined : handleKeyDown}
        />
      );
    default:
      return null;
  }
}, areTerminalPropsEqual);
