import { useRef, useEffect } from "react";
import { UIMessage } from "@ai-sdk/react";
import { useGlobalState } from "../contexts/GlobalState";
import type { SidebarFile } from "@/types/chat";

interface AutoOpenResult {
  shouldOpen: boolean;
  file?: SidebarFile;
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

  // Check for tools with output-available that should show in sidebar
  for (const part of lastAssistantMessage.parts || []) {
    const toolPart = part as any; // Type assertion for tool parts

    if (toolPart.state === "output-available") {
      // Check for readFile tool
      if (toolPart.type === "tool-readFile" && toolPart.output?.result) {
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
          file: {
            path: input.target_file,
            content: cleanContent,
            range,
            action: "reading",
          },
        };
      }

      // Check for writeFile tool
      if (toolPart.type === "tool-writeFile" && toolPart.input?.file_path) {
        const input = toolPart.input as { file_path: string; contents: string };

        return {
          shouldOpen: true,
          file: {
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
  const { openFileInSidebar } = useGlobalState();
  const hasOpenedSidebarRef = useRef<string | null>(null);

  // Auto-open sidebar when new assistant messages have content to show
  useEffect(() => {
    const lastAssistantMessage = messages[lastAssistantMessageIndex || -1];

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
      result.file &&
      typeof window !== "undefined" &&
      window.matchMedia("(min-width: 950px)").matches
    ) {
      openFileInSidebar(result.file);
      hasOpenedSidebarRef.current = lastAssistantMessage?.id || null;
    }
  }, [messages, status, lastAssistantMessageIndex, openFileInSidebar]);

  // Return reset function
  const resetSidebarFlag = () => {
    hasOpenedSidebarRef.current = null;
  };

  return { resetSidebarFlag };
};
