"use client";

import { memo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useGlobalState } from "../contexts/GlobalState";
import { useIsMobile } from "@/hooks/use-mobile";

interface BranchIndicatorProps {
  branchedFromChatId: string;
  branchedFromChatTitle: string;
  onNavigate?: (chatId: string) => void;
}

export const BranchIndicator = memo(function BranchIndicator({
  branchedFromChatId,
  branchedFromChatTitle,
  onNavigate,
}: BranchIndicatorProps) {
  const router = useRouter();
  const { initializeChat, closeSidebar, setChatSidebarOpen } = useGlobalState();
  const isMobile = useIsMobile();

  const handleClick = useCallback(() => {
    if (onNavigate) {
      onNavigate(branchedFromChatId);
      return;
    }
    closeSidebar();

    if (isMobile) {
      setChatSidebarOpen(false);
    }

    initializeChat(branchedFromChatId);
    router.push(`/c/${branchedFromChatId}`);
  }, [
    onNavigate,
    branchedFromChatId,
    closeSidebar,
    isMobile,
    setChatSidebarOpen,
    initializeChat,
    router,
  ]);

  return (
    <div
      data-testid="branch-indicator"
      className="relative flex items-center justify-center py-6"
    >
      <div className="absolute inset-0 flex items-center">
        <div className="w-full border-t border-border"></div>
      </div>
      <div className="relative flex items-center gap-2 bg-background px-4">
        <span className="text-sm text-muted-foreground">
          Branched from{" "}
          <button
            onClick={handleClick}
            className="font-medium underline hover:text-foreground/50 transition-colors cursor-pointer"
            type="button"
            aria-label={`Open branched-from chat ${branchedFromChatTitle}`}
          >
            {branchedFromChatTitle}
          </button>
        </span>
      </div>
    </div>
  );
});
