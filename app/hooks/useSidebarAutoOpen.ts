import { useRef, useEffect } from "react";
import { UIMessage } from "@ai-sdk/react";
import { useGlobalState } from "../contexts/GlobalState";
import { isSidebarFile, SidebarContent } from "@/types/chat";

interface AutoOpenResult {
  shouldOpen: boolean;
  content?: SidebarContent;
}

const checkForSidebarContent = (
  messages: UIMessage[],
  lastAssistantMessageIndex: number | undefined,
  status: "ready" | "submitted" | "streaming" | "error",
): AutoOpenResult => {
  // Only check during streaming and when we have messages
  if (
    status !== "streaming" ||
    messages.length === 0 ||
    lastAssistantMessageIndex === undefined
  ) {
    return { shouldOpen: false };
  }

  const lastAssistantMessage = messages[lastAssistantMessageIndex];
  if (!lastAssistantMessage || lastAssistantMessage.role !== "assistant") {
    return { shouldOpen: false };
  }

  // Check for tools that should show in sidebar
  for (const part of lastAssistantMessage.parts || []) {
    const toolPart = part as any; // Type assertion for tool parts

    // Check for terminal tools when they start executing (input-available state)
    if (
      toolPart.state === "input-available" &&
      toolPart.type === "tool-run_terminal_cmd" &&
      toolPart.input?.command
    ) {
      const input = toolPart.input as {
        command: string;
        is_background: boolean;
      };

      return {
        shouldOpen: true,
        content: {
          command: input.command,
          output: "", // Empty initially, will be populated by streaming
          isExecuting: true,
          isBackground: input.is_background,
          toolCallId: toolPart.toolCallId,
        },
      };
    }

    if (toolPart.state === "output-available") {
      // Check for readFile tool
      if (toolPart.type === "tool-read_file" && toolPart.output?.result) {
        const input = toolPart.input as {
          target_file: string;
          offset?: number;
          limit?: number;
        };
        const output = toolPart.output as { result: string };

        const cleanContent = output.result.replace(/^\s*\d+\|/gm, "");
        const range =
          input.offset && input.limit
            ? {
                start: input.offset,
                end: input.offset + input.limit - 1,
              }
            : undefined;

        return {
          shouldOpen: true,
          content: {
            path: input.target_file,
            content: cleanContent,
            range,
            action: "reading",
          },
        };
      }

      // Check for writeFile tool
      if (toolPart.type === "tool-write_file" && toolPart.input?.file_path) {
        const input = toolPart.input as { file_path: string; contents: string };

        return {
          shouldOpen: true,
          content: {
            path: input.file_path,
            content: input.contents,
            action: "writing",
          },
        };
      }
    }
  }

  return { shouldOpen: false };
};

export const useSidebarAutoOpen = (
  messages: UIMessage[],
  lastAssistantMessageIndex: number | undefined,
  status: "ready" | "submitted" | "streaming" | "error",
) => {
  const { openSidebar, updateSidebarContent, sidebarContent } =
    useGlobalState();
  const hasOpenedSidebarRef = useRef<string | null>(null);

  // Auto-open sidebar when new assistant messages have content to show
  useEffect(() => {
    const lastAssistantMessage = messages[lastAssistantMessageIndex ?? -1];

    // Skip if already opened for this message
    if (hasOpenedSidebarRef.current === lastAssistantMessage?.id) {
      return;
    }

    const result = checkForSidebarContent(
      messages,
      lastAssistantMessageIndex,
      status,
    );

    if (
      result.shouldOpen &&
      result.content &&
      typeof window !== "undefined" &&
      window.matchMedia("(min-width: 950px)").matches
    ) {
      openSidebar(result.content);
      hasOpenedSidebarRef.current = lastAssistantMessage?.id || null;
    }
  }, [messages, status, lastAssistantMessageIndex, openSidebar]);

  // Update sidebar with streaming terminal data
  useEffect(() => {
    if (
      !sidebarContent ||
      isSidebarFile(sidebarContent) ||
      !sidebarContent.isExecuting ||
      status !== "streaming"
    ) {
      return;
    }

    const lastAssistantMessage = messages[lastAssistantMessageIndex ?? -1];
    if (!lastAssistantMessage) return;

    // Find the terminal tool call that matches the sidebar content
    const terminalToolPart = lastAssistantMessage.parts.find(
      (part: any) =>
        part.type === "tool-run_terminal_cmd" &&
        part.toolCallId === sidebarContent.toolCallId,
    );

    if (!terminalToolPart) return;

    // Get all data-terminal parts for this tool call
    const terminalDataParts = lastAssistantMessage.parts.filter(
      (part: any) =>
        part.type === "data-terminal" &&
        part.data?.toolCallId === sidebarContent.toolCallId,
    );

    // Combine streaming output
    const streamingOutput = terminalDataParts
      .map((part: any) => part.data?.terminal || "")
      .join("");

    // Compute current execution state
    const newIsExecuting =
      (terminalToolPart as any).state === "input-available" &&
      status === "streaming";

    // Update if output changed OR execution state changed
    if (
      streamingOutput !== sidebarContent.output ||
      newIsExecuting !== sidebarContent.isExecuting
    ) {
      updateSidebarContent({
        output: streamingOutput,
        isExecuting: newIsExecuting,
      });
    }
  }, [
    messages,
    sidebarContent,
    updateSidebarContent,
    lastAssistantMessageIndex,
    status,
  ]);

  // Return reset function
  const resetSidebarFlag = () => {
    hasOpenedSidebarRef.current = null;
  };

  return { resetSidebarFlag };
};
