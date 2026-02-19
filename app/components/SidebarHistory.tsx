"use client";

import React, { useRef, useEffect } from "react";
import { MessageSquare } from "lucide-react";
import ChatItem from "./ChatItem";
import Loading from "@/components/ui/loading";

interface SidebarHistoryProps {
  chats: any[];
  paginationStatus?:
    | "LoadingFirstPage"
    | "CanLoadMore"
    | "LoadingMore"
    | "Exhausted";
  loadMore?: (numItems: number) => void;
  containerRef?: React.RefObject<HTMLDivElement | null>;
}

const SidebarHistory: React.FC<SidebarHistoryProps> = ({
  chats,
  paginationStatus,
  loadMore,
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

    if (paginationStatus === "CanLoadMore" && chats.length > 0 && loadMore) {
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

  if (!chats || chats.length === 0) {
    // Empty state
    return (
      <div
        className="flex flex-col items-center justify-center h-full p-6 text-center"
        data-testid="sidebar-chat-empty"
      >
        <MessageSquare className="w-12 h-12 text-sidebar-accent-foreground mb-4" />
        <h3 className="text-lg font-medium text-sidebar-foreground mb-2">
          No chats yet
        </h3>
        <p className="text-sm text-sidebar-accent-foreground mb-4">
          Start a conversation to see your chat history here
        </p>
      </div>
    );
  }

  // Chat list with buttons (same for mobile and desktop)
  return (
    <div className="p-2 space-y-1" data-testid="sidebar-chat-list">
      {chats.map((chat: any) => (
        <ChatItem
          key={chat._id}
          id={chat.id}
          title={chat.title}
          isBranched={!!chat.branched_from_chat_id}
          branchedFromTitle={chat.branched_from_title}
          shareId={chat.share_id}
          shareDate={chat.share_date}
          isPinned={chat.pinned_at != null}
        />
      ))}

      {/* Loading indicator when loading more */}
      {paginationStatus === "LoadingMore" && (
        <div className="flex justify-center py-2">
          <Loading size={6} />
        </div>
      )}

      {/* Sentinel for IntersectionObserver – load more when scrolled into view */}
      {paginationStatus === "CanLoadMore" && chats.length > 0 && (
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
