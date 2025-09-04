"use client";

import React, { useState, useEffect, useRef } from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Search, MessageSquare, X, Loader2, MessageCircle } from "lucide-react";
import {
  format,
  isToday,
  isYesterday,
  isThisWeek,
  isThisMonth,
} from "date-fns";
import type { Doc } from "@/convex/_generated/dataModel";
import { useGlobalState } from "../contexts/GlobalState";
import { useIsMobile } from "@/hooks/use-mobile";

interface MessageSearchResult {
  id: string;
  chat_id: string;
  content: string;
  created_at: number;
  updated_at?: number;
  chat_title?: string;
  match_type: "message" | "title" | "both";
}

interface MessageSearchDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

type DateCategory =
  | "Today"
  | "Yesterday"
  | "Previous 7 Days"
  | "Previous 30 Days"
  | "Older";

export const MessageSearchDialog: React.FC<MessageSearchDialogProps> = ({
  isOpen,
  onClose,
}) => {
  const { user } = useAuth();
  const router = useRouter();
  const { chats, setChatSidebarOpen } = useGlobalState();
  const isMobile = useIsMobile();
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [allResults, setAllResults] = useState<MessageSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const loaderRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Use Convex usePaginatedQuery for search
  const searchResults = usePaginatedQuery(
    api.messages.searchMessages,
    debouncedQuery.trim() && user
      ? { searchQuery: debouncedQuery.trim() }
      : "skip",
    { initialNumItems: 20 },
  );

  // Date categorization functions
  const getChatDateCategory = (chat: Doc<"chats">): DateCategory => {
    const chatDate = new Date(chat.update_time);

    if (isToday(chatDate)) return "Today";
    if (isYesterday(chatDate)) return "Yesterday";
    if (isThisWeek(chatDate)) return "Previous 7 Days";
    if (isThisMonth(chatDate)) return "Previous 30 Days";
    return "Older";
  };

  const getChatsByCategory = (category: DateCategory) => {
    return chats.filter((chat) => getChatDateCategory(chat) === category);
  };

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Handle search results updates
  useEffect(() => {
    if (searchResults.status === "LoadingFirstPage") {
      setIsSearching(true);
      setAllResults([]);
    } else if (
      searchResults.status === "CanLoadMore" ||
      searchResults.status === "Exhausted"
    ) {
      setIsSearching(false);

      if (searchResults.results) {
        // Ensure unique results by ID
        const uniqueResults = searchResults.results.filter(
          (item, index, self) =>
            index === self.findIndex((t) => t.id === item.id),
        );
        setAllResults(uniqueResults);
      }
    }
  }, [searchResults.status, searchResults.results]);

  // Reset results when query changes
  useEffect(() => {
    if (!debouncedQuery.trim()) {
      setAllResults([]);
      setIsSearching(false);
    }
  }, [debouncedQuery]);

  // Set up Intersection Observer for infinite scrolling
  useEffect(() => {
    const options = {
      root: null,
      rootMargin: "100px",
      threshold: 0.1,
    };

    observerRef.current = new IntersectionObserver((entries) => {
      const [entry] = entries;
      if (
        entry.isIntersecting &&
        searchResults.status === "CanLoadMore" &&
        debouncedQuery.trim()
      ) {
        searchResults.loadMore(20);
      }
    }, options);

    if (
      loaderRef.current &&
      debouncedQuery.trim() &&
      searchResults.status === "CanLoadMore"
    ) {
      observerRef.current.observe(loaderRef.current);
    }

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [loaderRef, searchResults.status, debouncedQuery, searchResults.loadMore]);

  const handleChatClick = (chatId: string) => {
    router.push(`/c/${chatId}`);
    onClose();

    // Close sidebar only on mobile for better UX
    if (isMobile) {
      setChatSidebarOpen(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    }
  };

  // Handle Cmd/Ctrl + K to close dialog when open
  useEffect(() => {
    if (!isOpen) return;

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      document.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [isOpen, onClose]);

  const highlightSearchTerm = (text: string, searchTerm: string) => {
    if (!searchTerm.trim()) return text;

    const regex = new RegExp(
      `(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
      "gi",
    );
    const parts = text.split(regex);

    return parts.map((part, index) =>
      regex.test(part) ? (
        <mark
          key={index}
          className="bg-yellow-200 dark:bg-yellow-800 px-1 rounded"
        >
          {part}
        </mark>
      ) : (
        part
      ),
    );
  };

  const formatSearchResultDate = (timestamp: number) => {
    const date = new Date(timestamp);
    if (isToday(date)) return "Today";
    if (isYesterday(date)) return "Yesterday";
    return format(date, "MMM d");
  };

  const truncateContent = (content: string, maxLength: number = 200) => {
    if (content.length <= maxLength) return content;
    return content.slice(0, maxLength) + "...";
  };

  const getMatchIcon = (matchType: "message" | "title" | "both") => {
    // Use consistent MessageSquare icon for all match types
    return (
      <MessageSquare size={16} className="text-muted-foreground shrink-0" />
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        className="flex flex-col max-w-[680px] w-full h-[440px] p-0 gap-0"
        onKeyDown={handleKeyDown}
        showCloseButton={false}
      >
        <DialogHeader className="border-b flex-shrink-0 p-0">
          <DialogTitle className="sr-only">Search Messages</DialogTitle>
          <div className="ms-6 me-4 flex h-16 items-center justify-between">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <Search size={20} className="text-muted-foreground shrink-0" />
              <Input
                placeholder="Search messages..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 text-base placeholder:text-muted-foreground"
                autoFocus
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="h-8 w-8 p-0 hover:bg-muted/50 shrink-0"
            >
              <X size={18} />
            </Button>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-hidden">
          <div className="h-full overflow-y-auto">
            {!debouncedQuery.trim() ? (
              chats.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground">
                  <div className="text-center">
                    <MessageCircle
                      size={48}
                      className="mx-auto mb-4 opacity-50"
                    />
                    <p className="text-sm">No chats yet</p>
                    <p className="text-xs mt-2">
                      Start a conversation to see your chats here
                    </p>
                  </div>
                </div>
              ) : (
                <div className="py-2">
                  {(
                    [
                      "Today",
                      "Yesterday",
                      "Previous 7 Days",
                      "Previous 30 Days",
                      "Older",
                    ] as DateCategory[]
                  ).map((category) => {
                    const categoryChats = getChatsByCategory(category);

                    if (categoryChats.length === 0) return null;

                    return (
                      <div key={category}>
                        <div className="px-6 py-2 text-xs font-semibold text-muted-foreground bg-muted/30 sticky top-0 z-10">
                          {category}
                        </div>
                        {categoryChats.map((chat) => (
                          <div
                            key={chat.id}
                            className="px-6 py-3 hover:bg-muted/50 cursor-pointer transition-colors border-b border-border/50 last:border-b-0"
                            onClick={() => handleChatClick(chat.id)}
                          >
                            <div className="flex items-center gap-3">
                              <MessageSquare
                                size={16}
                                className="text-muted-foreground shrink-0"
                              />
                              <span className="text-sm font-medium truncate">
                                {chat.title}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )
            ) : isSearching ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="animate-spin mr-2" size={20} />
                <span className="text-sm">Searching...</span>
              </div>
            ) : allResults.length === 0 ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <div className="text-center">
                  <Search size={48} className="mx-auto mb-4 opacity-50" />
                  <p className="text-sm">No messages found</p>
                  <p className="text-xs mt-2">
                    Try different keywords or phrases
                  </p>
                </div>
              </div>
            ) : (
              <div className="py-2">
                {allResults.map((message, index) => (
                  <div
                    key={`${message.id}-${index}`}
                    className="px-6 py-3 hover:bg-muted/50 cursor-pointer transition-colors border-b border-border/50 last:border-b-0"
                    onClick={() => handleChatClick(message.chat_id)}
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="flex items-center gap-3 min-w-0">
                        {getMatchIcon(message.match_type)}
                        <span className="text-sm font-medium truncate">
                          {highlightSearchTerm(
                            message.chat_title || "Untitled Chat",
                            message.match_type === "title" ||
                              message.match_type === "both"
                              ? debouncedQuery
                              : "",
                          )}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {formatSearchResultDate(
                          message.updated_at || message.created_at,
                        )}
                      </span>
                    </div>

                    {/* Only show message content for message and both matches, not for title-only matches */}
                    {message.content &&
                      (message.match_type === "message" ||
                        message.match_type === "both") && (
                        <div className="text-sm line-clamp-3 text-foreground/80 leading-relaxed ml-7">
                          {highlightSearchTerm(
                            truncateContent(message.content),
                            debouncedQuery,
                          )}
                        </div>
                      )}
                  </div>
                ))}

                {/* Loader element for intersection observer */}
                {searchResults.status === "CanLoadMore" &&
                  debouncedQuery.trim() && (
                    <div ref={loaderRef} className="flex justify-center py-4">
                      <Loader2 className="animate-spin mr-2" size={16} />
                      <span className="text-sm">Loading more...</span>
                    </div>
                  )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
