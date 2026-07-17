"use client";

import React, { useRef, useEffect } from "react";
import { MessageSquare } from "lucide-react";
import ChatItem from "./ChatItem";
import Loading from "@/components/ui/loading";

export type SidebarPaginationStatus =
  "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";

interface SidebarHistoryProps {
  chats: any[];
  paginationStatus?: SidebarPaginationStatus;
  loadMore?: (numItems: number) => void;
  containerRef?: React.RefObject<HTMLDivElement | null>;
  showEmptyState?: boolean;
  testId?: string;
}

const SidebarHistory: React.FC<SidebarHistoryProps> = ({
  chats,
  paginationStatus,
  loadMore,
  showEmptyState = true,
  testId = "sidebar-chat-list",
}) => {
  const loaderRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const statusRef = useRef(paginationStatus);

  // IntersectionObserver for infinite scroll – reliable vs scroll listener on ref that can be null
  useEffect(() => {
    statusRef.current = paginationStatus;
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    if (paginationStatus === "CanLoadMore" && loadMore) {
      const options: IntersectionObserverInit = {
        root: null,
        rootMargin: "50px",
        threshold: 0.1,
      };

      observerRef.current = new IntersectionObserver((entries) => {
        const [entry] = entries;
        if (entry.isIntersecting && statusRef.current === "CanLoadMore") {
          loadMore(28);
        }
      }, options);

      const currentLoader = loaderRef.current;
      if (currentLoader) {
        observerRef.current.observe(currentLoader);
      }
    }

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [paginationStatus, loadMore, chats.length]);

  if (paginationStatus === "LoadingFirstPage") {
    // Loading state
    return (
      <div className="p-2">
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="animate-pulse">
              <div className="h-4 bg-sidebar-accent rounded w-3/4 mb-2"></div>
              <div className="h-3 bg-sidebar-accent rounded w-1/2"></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const isWaitingForMore =
    paginationStatus === "CanLoadMore" || paginationStatus === "LoadingMore";

  if ((!chats || chats.length === 0) && !isWaitingForMore) {
    if (!showEmptyState) return null;
    // Empty state
    return (
      <div
        className="flex flex-col items-center justify-center h-full p-6 text-center"
        data-testid="sidebar-chat-empty"
      >
        <MessageSquare className="w-12 h-12 text-sidebar-accent-foreground mb-4" />
        <h3 className="text-lg font-medium text-sidebar-foreground mb-2">
          No tasks yet
        </h3>
        <p className="text-sm text-sidebar-accent-foreground mb-4">
          Start a task to see your task history here
        </p>
      </div>
    );
  }

  // Chat list with buttons (same for mobile and desktop)
  return (
    <div className="space-y-1 py-2" data-testid={testId}>
      {chats.map((chat: any) => (
        <ChatItem
          key={chat._id}
          id={chat.id}
          title={chat.title}
          projectId={chat.project_id}
          isBranched={!!chat.branched_from_chat_id}
          branchedFromTitle={chat.branched_from_title}
          shareId={chat.share_id}
          isPinned={chat.pinned_at != null}
          isStreaming={
            !!chat.active_stream_id ||
            !!chat.active_trigger_run_id ||
            !!chat.active_agent_approval_pending
          }
          isAwaitingApproval={!!chat.active_agent_approval_pending}
        />
      ))}

      {/* Loading indicator when loading more */}
      {paginationStatus === "LoadingMore" && (
        <div className="flex justify-center py-2">
          <Loading size={6} />
        </div>
      )}

      {/* Sentinel for IntersectionObserver – load more when scrolled into view */}
      {paginationStatus === "CanLoadMore" && (
        <div
          ref={loaderRef}
          data-testid="sidebar-load-more-sentinel"
          className="flex justify-center py-2 text-sidebar-accent-foreground"
          aria-hidden
        >
          <span className="text-xs">Scroll for more</span>
        </div>
      )}
    </div>
  );
};

export default SidebarHistory;
