import { useMemo, useCallback } from "react";
import type { MouseEvent } from "react";
import {
  extractAllSidebarContent,
  type Message,
} from "@/lib/utils/sidebar-utils";
import {
  isSidebarFile,
  isSidebarTerminal,
  isSidebarPython,
  isSidebarWebSearch,
  type SidebarContent,
} from "@/types/chat";

interface UseSidebarNavigationProps {
  messages: Message[];
  sidebarContent: SidebarContent | null;
  onNavigate?: (content: SidebarContent) => void;
}

export const useSidebarNavigation = ({
  messages,
  sidebarContent,
  onNavigate,
}: UseSidebarNavigationProps) => {
  const toolExecutions = useMemo(
    () => extractAllSidebarContent(messages),
    [messages],
  );

  const currentIndex = useMemo(() => {
    if (!sidebarContent) return -1;

    // Try to match by toolCallId first (most reliable)
    const contentToolCallId =
      "toolCallId" in sidebarContent ? sidebarContent.toolCallId : undefined;

    if (contentToolCallId) {
      const index = toolExecutions.findIndex(
        (item) => "toolCallId" in item && item.toolCallId === contentToolCallId,
      );
      if (index !== -1) return index;
    }

    // Fallback to content-based matching
    return toolExecutions.findIndex((item) => {
      if (isSidebarTerminal(item) && isSidebarTerminal(sidebarContent)) {
        return (
          item.command === sidebarContent.command &&
          item.toolCallId === sidebarContent.toolCallId
        );
      }
      if (isSidebarFile(item) && isSidebarFile(sidebarContent)) {
        return (
          item.path === sidebarContent.path &&
          item.action === sidebarContent.action
        );
      }
      if (isSidebarPython(item) && isSidebarPython(sidebarContent)) {
        return item.code === sidebarContent.code;
      }
      if (isSidebarWebSearch(item) && isSidebarWebSearch(sidebarContent)) {
        return item.toolCallId === sidebarContent.toolCallId;
      }
      return false;
    });
  }, [sidebarContent, toolExecutions]);

  const handlePrev = useCallback(() => {
    if (currentIndex > 0 && onNavigate) {
      onNavigate(toolExecutions[currentIndex - 1]);
    }
  }, [currentIndex, toolExecutions, onNavigate]);

  const handleNext = useCallback(() => {
    if (currentIndex < toolExecutions.length - 1 && onNavigate) {
      onNavigate(toolExecutions[currentIndex + 1]);
    }
  }, [currentIndex, toolExecutions, onNavigate]);

  const handleJumpToLive = useCallback(() => {
    if (toolExecutions.length > 0 && onNavigate) {
      onNavigate(toolExecutions[toolExecutions.length - 1]);
    }
  }, [toolExecutions, onNavigate]);

  const handleSliderClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (toolExecutions.length === 0 || !onNavigate) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percentage = Math.max(0, Math.min(1, x / rect.width));

      const targetIndex = Math.round(percentage * (toolExecutions.length - 1));
      const clampedIndex = Math.max(
        0,
        Math.min(targetIndex, toolExecutions.length - 1),
      );

      onNavigate(toolExecutions[clampedIndex]);
    },
    [toolExecutions, onNavigate],
  );

  const getProgressPercentage = useMemo(() => {
    if (toolExecutions.length <= 1) return 100;
    const effectiveIndex = Math.max(
      0,
      Math.min(currentIndex, toolExecutions.length - 1),
    );
    return Math.max(
      0,
      Math.min(100, (effectiveIndex / (toolExecutions.length - 1)) * 100),
    );
  }, [currentIndex, toolExecutions.length]);

  const isAtLive = currentIndex === toolExecutions.length - 1;
  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex < toolExecutions.length - 1;

  const maxIndex = Math.max(0, toolExecutions.length - 1);

  return {
    toolExecutions,
    currentIndex,
    maxIndex,
    handlePrev,
    handleNext,
    handleJumpToLive,
    handleSliderClick,
    getProgressPercentage,
    isAtLive,
    canGoPrev,
    canGoNext,
  };
};
