"use client";

import React, { useCallback, useState, useEffect, useRef } from "react";
import { useConvex } from "convex/react";
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
import { useChats } from "../hooks/useChats";
import {
  MAX_MESSAGE_SEARCH_QUERY_LENGTH,
  MIN_MESSAGE_SEARCH_QUERY_LENGTH,
  splitTextBySearchTerm,
} from "@/lib/utils/message-search";
import { formatTaskTitle } from "@/app/utils/task-ui-copy";

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
  "Today" | "Yesterday" | "Previous 7 Days" | "Previous 30 Days" | "Older";

const resolveNextCursor = (result: {
  isDone: boolean;
  continueCursor?: string | null;
}) => (result.isDone || !result.continueCursor ? null : result.continueCursor);

export const MessageSearchDialog: React.FC<MessageSearchDialogProps> = ({
  isOpen,
  onClose,
}) => {
  const { user } = useAuth();
  const router = useRouter();
  const convex = useConvex();
  const { setChatSidebarOpen, closeSidebar } = useGlobalState();
  const isMobile = useIsMobile();
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // Only fetch chats when dialog is open and there's no search query
  const shouldFetchChats = isOpen && !searchQuery.trim();
  const chatsQuery = useChats(shouldFetchChats);
  const chats = chatsQuery.results ?? [];
  const trimmedDebouncedQuery = debouncedQuery.trim();
  const isSearchReady =
    trimmedDebouncedQuery.length >= MIN_MESSAGE_SEARCH_QUERY_LENGTH &&
    trimmedDebouncedQuery.length <= MAX_MESSAGE_SEARCH_QUERY_LENGTH;
  const [allResults, setAllResults] = useState<MessageSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState<
    "initial" | "pagination" | null
  >(null);
  const [continueCursor, setContinueCursor] = useState<string | null>(null);
  const loaderRef = useRef<HTMLDivElement>(null);
  const chatsLoaderRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const chatsObserverRef = useRef<IntersectionObserver | null>(null);
  const searchGenerationRef = useRef(0);
  const canSearch = isOpen && isSearchReady && Boolean(user);

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

  // Clear the query when the dialog closes so a previous search cannot restart
  // when the always-mounted sidebar header renders again.
  useEffect(() => {
    if (isOpen) return;
    setSearchQuery("");
    setDebouncedQuery("");
  }, [isOpen]);

  // Message history search does not need realtime updates. A one-shot query
  // prevents Convex from keeping a costly full-text subscription alive while
  // messages are written in the background.
  useEffect(() => {
    const generation = searchGenerationRef.current + 1;
    searchGenerationRef.current = generation;
    let cancelled = false;

    if (!canSearch) {
      setAllResults([]);
      setIsSearching(false);
      setIsLoadingMore(false);
      setSearchError(null);
      setContinueCursor(null);
      return;
    }

    setAllResults([]);
    setIsSearching(true);
    setIsLoadingMore(false);
    setSearchError(null);
    setContinueCursor(null);

    const loadFirstPage = async () => {
      try {
        const result = await convex.query(api.messages.searchMessages, {
          searchQuery: trimmedDebouncedQuery,
          paginationOpts: { numItems: 20, cursor: null },
        });
        if (cancelled || searchGenerationRef.current !== generation) return;

        setAllResults(result.page);
        setContinueCursor(resolveNextCursor(result));
      } catch (error) {
        if (cancelled || searchGenerationRef.current !== generation) return;
        console.error("Failed to search messages:", error);
        setAllResults([]);
        setSearchError("initial");
        setContinueCursor(null);
      } finally {
        if (!cancelled && searchGenerationRef.current === generation) {
          setIsSearching(false);
        }
      }
    };

    void loadFirstPage();

    return () => {
      cancelled = true;
    };
  }, [canSearch, convex, trimmedDebouncedQuery]);

  const loadMoreSearchResults = useCallback(async () => {
    if (!canSearch || !continueCursor || isLoadingMore) return;

    const generation = searchGenerationRef.current;
    setIsLoadingMore(true);
    setSearchError(null);

    try {
      const result = await convex.query(api.messages.searchMessages, {
        searchQuery: trimmedDebouncedQuery,
        paginationOpts: { numItems: 10, cursor: continueCursor },
      });
      if (searchGenerationRef.current !== generation) return;

      setAllResults((current) => [...current, ...result.page]);
      setContinueCursor(resolveNextCursor(result));
    } catch (error) {
      if (searchGenerationRef.current !== generation) return;
      console.error("Failed to load more message search results:", error);
      setSearchError("pagination");
      setContinueCursor(null);
    } finally {
      if (searchGenerationRef.current === generation) {
        setIsLoadingMore(false);
      }
    }
  }, [canSearch, continueCursor, convex, isLoadingMore, trimmedDebouncedQuery]);

  // Set up Intersection Observer for infinite scrolling of search results
  useEffect(() => {
    // Clean up existing observer
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    // Only set up observer if we have results and can load more
    if (continueCursor && canSearch && allResults.length > 0) {
      const options = {
        root: null,
        rootMargin: "50px",
        threshold: 0.1,
      };

      observerRef.current = new IntersectionObserver((entries) => {
        const [entry] = entries;
        if (
          entry.isIntersecting &&
          continueCursor &&
          canSearch &&
          !isLoadingMore
        ) {
          void loadMoreSearchResults();
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
  }, [
    continueCursor,
    canSearch,
    loadMoreSearchResults,
    isLoadingMore,
    allResults.length,
  ]);

  // Set up Intersection Observer for infinite scrolling of chats
  useEffect(() => {
    // Clean up existing observer
    if (chatsObserverRef.current) {
      chatsObserverRef.current.disconnect();
    }

    // Only set up observer if we have chats and can load more, and no search query
    if (
      chatsQuery.status === "CanLoadMore" &&
      !debouncedQuery.trim() &&
      chats.length > 0
    ) {
      const options = {
        root: null,
        rootMargin: "50px",
        threshold: 0.1,
      };

      chatsObserverRef.current = new IntersectionObserver((entries) => {
        const [entry] = entries;
        if (
          entry.isIntersecting &&
          chatsQuery.status === "CanLoadMore" &&
          !debouncedQuery.trim() &&
          !chatsQuery.isLoading
        ) {
          chatsQuery.loadMore(8);
        }
      }, options);

      const currentLoader = chatsLoaderRef.current;
      if (currentLoader) {
        chatsObserverRef.current.observe(currentLoader);
      }
    }

    return () => {
      if (chatsObserverRef.current) {
        chatsObserverRef.current.disconnect();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chatsQuery.status,
    debouncedQuery,
    chatsQuery.loadMore,
    chatsQuery.isLoading,
    chats.length,
  ]);

  const handleChatClick = (chatId: string) => {
    // Close computer sidebar when navigating to a chat
    closeSidebar();

    // Close chat sidebar only on mobile for better UX
    if (isMobile) {
      setChatSidebarOpen(false);
    }

    router.push(`/c/${chatId}`);
    onClose();
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

    return splitTextBySearchTerm(text, searchTerm).map((segment, index) =>
      segment.isMatch ? (
        <mark
          key={index}
          className="bg-yellow-200 dark:bg-yellow-800 px-1 rounded"
        >
          {segment.text}
        </mark>
      ) : (
        segment.text
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

  const getMatchIcon = () => {
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
                maxLength={MAX_MESSAGE_SEARCH_QUERY_LENGTH}
                onChange={(e) =>
                  setSearchQuery(
                    e.target.value.slice(0, MAX_MESSAGE_SEARCH_QUERY_LENGTH),
                  )
                }
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
            {!trimmedDebouncedQuery ? (
              chats.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground">
                  <div className="text-center">
                    <MessageCircle
                      size={48}
                      className="mx-auto mb-4 opacity-50"
                    />
                    <p className="text-sm">No tasks yet</p>
                    <p className="text-xs mt-2">
                      Start a task to see your tasks here
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
                        <div className="px-6 py-2 text-xs font-semibold text-muted-foreground bg-background sticky top-0 z-10">
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
                                {formatTaskTitle(chat.title)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })}

                  {/* Loader element for chats pagination - only show if we have chats and can load more */}
                  {chatsQuery.status === "CanLoadMore" &&
                    !debouncedQuery.trim() &&
                    chats.length > 0 &&
                    !chatsQuery.isLoading && (
                      <div
                        ref={chatsLoaderRef}
                        className="flex justify-center py-4 text-muted-foreground"
                      >
                        <div className="text-sm">Scroll for more tasks...</div>
                      </div>
                    )}

                  {/* Show loading state when actively loading more chats */}
                  {chatsQuery.isLoading && chats.length > 0 && (
                    <div className="flex justify-center py-4">
                      <Loader2 className="animate-spin mr-2" size={16} />
                      <span className="text-sm">Loading more tasks...</span>
                    </div>
                  )}
                </div>
              )
            ) : !isSearchReady ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <div className="text-center">
                  <Search size={48} className="mx-auto mb-4 opacity-50" />
                  <p className="text-sm">Keep typing</p>
                  <p className="text-xs mt-2">
                    Search starts at {MIN_MESSAGE_SEARCH_QUERY_LENGTH}{" "}
                    characters
                  </p>
                </div>
              </div>
            ) : isSearching ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="animate-spin mr-2" size={20} />
                <span className="text-sm">Searching...</span>
              </div>
            ) : searchError === "initial" ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <div className="text-center">
                  <Search size={48} className="mx-auto mb-4 opacity-50" />
                  <p className="text-sm">Search failed</p>
                  <p className="text-xs mt-2">
                    Try again or use different keywords
                  </p>
                </div>
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
                        {getMatchIcon()}
                        <span className="text-sm font-medium truncate">
                          {highlightSearchTerm(
                            message.chat_title
                              ? formatTaskTitle(message.chat_title)
                              : "Untitled Task",
                            message.match_type === "title" ||
                              message.match_type === "both"
                              ? trimmedDebouncedQuery
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
                            trimmedDebouncedQuery,
                          )}
                        </div>
                      )}
                  </div>
                ))}

                {/* Loader element for intersection observer - only show if we have results and can load more */}
                {continueCursor &&
                  canSearch &&
                  allResults.length > 0 &&
                  !isLoadingMore && (
                    <div
                      ref={loaderRef}
                      className="flex justify-center py-4 text-muted-foreground"
                    >
                      <div className="text-sm">Scroll for more results...</div>
                    </div>
                  )}

                {/* Show loading state when actively loading more */}
                {isLoadingMore && allResults.length > 0 && (
                  <div className="flex justify-center py-4">
                    <Loader2 className="animate-spin mr-2" size={16} />
                    <span className="text-sm">Loading more...</span>
                  </div>
                )}

                {searchError === "pagination" && (
                  <div className="flex justify-center py-4 text-muted-foreground">
                    <span className="text-sm">
                      Couldn&apos;t load more results. Try searching again.
                    </span>
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
