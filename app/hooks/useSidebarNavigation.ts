import { useMemo, useCallback } from "react";
import type { MouseEvent } from "react";
import {
  extractAllSidebarContent,
  isSameSidebarContent,
  type Message,
} from "@/lib/utils/sidebar-utils";
import type { SidebarContent } from "@/types/chat";

interface UseSidebarNavigationProps {
  messages: Message[];
  sidebarContent: SidebarContent | null;
  onNavigate?: (
    content: SidebarContent,
    context: { isLatest: boolean },
  ) => void;
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

    return toolExecutions.findIndex((item) =>
      isSameSidebarContent(item, sidebarContent),
    );
  }, [sidebarContent, toolExecutions]);

  const handlePrev = useCallback(() => {
    if (currentIndex > 0 && onNavigate) {
      const targetIndex = currentIndex - 1;
      onNavigate(toolExecutions[targetIndex], {
        isLatest: targetIndex === toolExecutions.length - 1,
      });
    }
  }, [currentIndex, toolExecutions, onNavigate]);

  const handleNext = useCallback(() => {
    if (currentIndex < toolExecutions.length - 1 && onNavigate) {
      const targetIndex = currentIndex + 1;
      onNavigate(toolExecutions[targetIndex], {
        isLatest: targetIndex === toolExecutions.length - 1,
      });
    }
  }, [currentIndex, toolExecutions, onNavigate]);

  const handleJumpToLive = useCallback(() => {
    if (toolExecutions.length > 0 && onNavigate) {
      onNavigate(toolExecutions[toolExecutions.length - 1], {
        isLatest: true,
      });
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

      onNavigate(toolExecutions[clampedIndex], {
        isLatest: clampedIndex === toolExecutions.length - 1,
      });
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
