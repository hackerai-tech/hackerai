"use client";

import React from "react";
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
  containerRef,
}) => {
  // Handle scroll to load more chats when scrolling to bottom
  React.useEffect(() => {
    const handleScroll = () => {
      if (
        !containerRef?.current ||
        !loadMore ||
        paginationStatus !== "CanLoadMore"
      ) {
        return;
      }

      const { scrollTop, scrollHeight, clientHeight } = containerRef.current;

      // Check if we're near the bottom (within 100px)
      if (scrollTop + clientHeight >= scrollHeight - 100) {
        loadMore(28); // Load 28 more chats
      }
    };

    const container = containerRef?.current;
    if (container) {
      container.addEventListener("scroll", handleScroll);
      return () => container.removeEventListener("scroll", handleScroll);
    }
  }, [containerRef, loadMore, paginationStatus]);

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
      <div className="flex flex-col items-center justify-center h-full p-6 text-center">
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
    <div className="p-2 space-y-1">
      {chats.map((chat: any) => (
        <ChatItem
          key={chat._id}
          id={chat.id}
          title={chat.title}
          isBranched={!!chat.branched_from_chat_id}
          branchedFromTitle={chat.branched_from_title}
        />
      ))}

      {/* Loading indicator when loading more */}
      {paginationStatus === "LoadingMore" && (
        <div className="flex justify-center py-2">
          <Loading size={6} />
        </div>
      )}
    </div>
  );
};

export default SidebarHistory;
