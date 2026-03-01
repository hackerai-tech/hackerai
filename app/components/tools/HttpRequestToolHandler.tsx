import React, { useMemo } from "react";
import { UIMessage } from "@ai-sdk/react";
import ToolBlock from "@/components/ui/tool-block";
import { Globe } from "lucide-react";
import type { ChatStatus, SidebarTerminal } from "@/types/chat";
import { isSidebarTerminal } from "@/types/chat";
import { useToolSidebar } from "../../hooks/useToolSidebar";

interface HttpRequestToolHandlerProps {
  message: UIMessage;
  part: any;
  status: ChatStatus;
}

export const HttpRequestToolHandler = ({
  message,
  part,
  status,
}: HttpRequestToolHandlerProps) => {
  const { toolCallId, state, input, output, errorText } = part;

  const httpInput = input as {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
    body?: string;
    json_body?: Record<string, unknown>;
    form_data?: Record<string, string>;
    follow_redirects?: boolean;
    timeout?: number;
    verify_ssl?: boolean;
    proxy?: string;
    auth?: { username: string; password: string };
  };

  const httpOutput = output as {
    success: boolean;
    output: string;
    error?: string;
    metadata?: Record<string, unknown>;
    http_success?: boolean;
  };

  // Build display command (similar to curl format)
  const displayCommand = useMemo(() => {
    if (!httpInput?.url) return "";
    const method = httpInput.method || "GET";
    return `${method} ${httpInput.url}`;
  }, [httpInput]);

  // Memoize streaming output computation (from data-terminal parts)
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
    const resultOutput = httpOutput?.output || "";
    const errorOutput = httpOutput?.error || errorText || "";
    return resultOutput || streamingOutput || errorOutput || "";
  }, [httpOutput, streamingOutput, errorText]);

  const isExecuting = state === "input-available" && status === "streaming";

  const sidebarContent = useMemo((): SidebarTerminal | null => {
    if (!httpInput?.url) return null;
    return {
      command: displayCommand,
      output: finalOutput,
      isExecuting,
      isBackground: false,
      toolCallId,
    };
  }, [httpInput?.url, displayCommand, finalOutput, isExecuting, toolCallId]);

  const { handleOpenInSidebar, handleKeyDown } = useToolSidebar({
    toolCallId,
    content: sidebarContent,
    typeGuard: isSidebarTerminal,
  });

  // Determine action text based on state
  const getActionText = (): string => {
    if (state === "input-streaming") return "Preparing request";
    if (isExecuting) return "Requesting";
    if (httpOutput?.error) return "Request failed";
    return "Requested";
  };

  switch (state) {
    case "input-streaming":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={<Globe />}
          action={getActionText()}
          isShimmer={true}
        />
      ) : null;
    case "input-available":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Globe />}
          action={getActionText()}
          target={displayCommand}
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
          icon={<Globe />}
          action={getActionText()}
          target={displayCommand}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      );
    case "output-error":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Globe />}
          action="Request failed"
          target={displayCommand}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      );
    default:
      return null;
  }
};
