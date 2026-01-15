import React, { useEffect, useMemo } from "react";
import { UIMessage } from "@ai-sdk/react";
import ToolBlock from "@/components/ui/tool-block";
import { Terminal } from "lucide-react";
import { useGlobalState } from "../../contexts/GlobalState";
import type { ChatStatus, SidebarTerminal } from "@/types/chat";
import { isSidebarTerminal } from "@/types/chat";

type ShellAction = "view" | "exec" | "wait" | "send" | "kill";

interface ShellInput {
  action: ShellAction;
  command?: string;
  input?: string;
  session: string;
  timeout?: number;
  brief?: string;
}

interface ShellResult {
  success: boolean;
  content?: string;
  running?: boolean;
  completed?: boolean;
  exitCode?: number;
  waiting_for_input?: boolean;
  current_command?: string;
}

interface ShellToolHandlerProps {
  message: UIMessage;
  part: any;
  status: ChatStatus;
}

const ACTION_LABELS: Record<ShellAction, string> = {
  exec: "Running command",
  send: "Writing to terminal",
  wait: "Waiting for completion",
  kill: "Terminating process",
  view: "Reading terminal",
};

export const ShellToolHandler = ({
  message,
  part,
  status,
}: ShellToolHandlerProps) => {
  const { openSidebar, sidebarOpen, sidebarContent, updateSidebarContent } =
    useGlobalState();
  const { toolCallId, state, input, output, errorText } = part;

  const shellInput = input as ShellInput | undefined;
  const shellOutput = output as { result: ShellResult } | undefined;

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
    return shellOutput?.result?.content || streamingOutput || errorText || "";
  }, [shellOutput, streamingOutput, errorText]);

  const isStreaming = status === "streaming";
  const isExecuting = state === "input-available" && isStreaming;

  const action = shellInput?.action ?? "exec";

  const getActionLabel = (): string => {
    return ACTION_LABELS[action] ?? ACTION_LABELS.exec;
  };

  const getTargetLabel = (): string => {
    if (!shellInput) return "";

    switch (shellInput.action) {
      case "exec":
        return shellInput.command || shellInput.session;
      case "send": {
        // Show the input being sent, truncate if too long
        const inputText = shellInput.input || "";
        // Format special keys nicely
        if (inputText === "C-c") return "Ctrl+C";
        if (inputText === "C-d") return "Ctrl+D";
        if (inputText === "C-z") return "Ctrl+Z";
        if (inputText === "C-\\") return "Ctrl+\\";
        // Truncate long input
        return inputText.length > 40
          ? `${inputText.slice(0, 37)}...`
          : inputText;
      }
      case "kill":
        return `session: ${shellInput.session}`;
      case "wait":
        return `session: ${shellInput.session}`;
      case "view":
        return `session: ${shellInput.session}`;
      default:
        return shellInput.session || "";
    }
  };

  const getSidebarTitle = (): string => {
    if (!shellInput) return "Shell";

    const session = shellInput.session || "default";

    switch (shellInput.action) {
      case "exec":
        return shellInput.command || `Session: ${session}`;
      case "send":
        return `Input to ${session}`;
      case "wait":
        return `Waiting: ${session}`;
      case "kill":
        return `Kill: ${session}`;
      case "view":
        return `Session: ${session}`;
      default:
        return `Session: ${session}`;
    }
  };

  const handleOpenInSidebar = () => {
    const sidebarTerminal: SidebarTerminal = {
      command: getSidebarTitle(),
      output: finalOutput,
      isExecuting,
      isBackground: false,
      showContentOnly: shellInput?.action !== "exec",
      toolCallId: toolCallId,
      shellAction: shellInput?.action,
      sessionName: shellInput?.session,
    };

    openSidebar(sidebarTerminal);
  };

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
          action="Preparing shell"
          isShimmer={true}
        />
      ) : null;
    case "input-available":
    case "output-available":
    case "output-error":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Terminal />}
          action={getActionLabel()}
          target={getTargetLabel()}
          isShimmer={state === "input-available" && status === "streaming"}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      );
    default:
      return null;
  }
};
