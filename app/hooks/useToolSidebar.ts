import { useEffect, useCallback } from "react";
import { useGlobalState } from "../contexts/GlobalState";
import type { SidebarContent } from "@/types/chat";

interface UseToolSidebarOptions {
  /** The toolCallId for this tool invocation */
  toolCallId: string;
  /**
   * The sidebar content to display. Return null if not yet ready to show.
   * IMPORTANT: Must be memoized with useMemo to prevent unnecessary updates.
   */
  content: SidebarContent | null;
  /** Type guard to check if current sidebar content matches this tool type */
  typeGuard: (content: SidebarContent) => boolean;
  /** Set to true to disable sidebar functionality entirely (e.g., open_url tool) */
  disabled?: boolean;
}

interface UseToolSidebarResult {
  /** Open this tool's content in the sidebar */
  handleOpenInSidebar: () => void;
  /** Keyboard handler (Enter/Space) to open sidebar */
  handleKeyDown: (e: React.KeyboardEvent) => void;
  /** Whether the sidebar is currently showing this tool's content */
  isSidebarActive: boolean;
}

/**
 * Reusable hook for tool sidebar integration. Handles:
 * - Opening sidebar with tool content on click/keyboard
 * - Detecting if sidebar is currently showing this tool
 * - Auto-updating sidebar content in real-time when active
 */
export function useToolSidebar({
  toolCallId,
  content,
  typeGuard,
  disabled = false,
}: UseToolSidebarOptions): UseToolSidebarResult {
  const { openSidebar, sidebarOpen, sidebarContent, updateSidebarContent } =
    useGlobalState();

  const isSidebarActive =
    !disabled &&
    sidebarOpen &&
    sidebarContent != null &&
    typeGuard(sidebarContent) &&
    "toolCallId" in sidebarContent &&
    (sidebarContent as { toolCallId?: string }).toolCallId === toolCallId;

  const handleOpenInSidebar = useCallback(() => {
    if (disabled || !content) return;
    openSidebar(content);
  }, [disabled, content, openSidebar]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleOpenInSidebar();
      }
    },
    [handleOpenInSidebar],
  );

  // Auto-update sidebar content in real-time when active
  useEffect(() => {
    if (!isSidebarActive || !content) return;
    updateSidebarContent(content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSidebarActive, content]);

  return { handleOpenInSidebar, handleKeyDown, isSidebarActive };
}
