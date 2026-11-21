"use client";

import { useEffect, useMemo } from "react";
import { useConvexAuth, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  mergeSavedFileMessages,
  type FileMessage,
  type SavedFileEntry,
} from "@/lib/workspace-preview/chat-files";

export const SAVED_CHAT_FILES_PAGE_SIZE = 14;
const NO_ENTRIES: SavedFileEntry[] = [];

/**
 * Discover saved files from the whole chat, not only the loaded message pages.
 * Loads every page while enabled; Convex resets results when chatId or auth changes.
 */
export function useSavedChatFiles({
  chatId,
  messages,
  enabled,
}: {
  chatId: string;
  messages: FileMessage[];
  enabled: boolean;
}): { messages: FileMessage[]; loading: boolean } {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const active = enabled && !isLoading && isAuthenticated;
  const { results, status, loadMore } = usePaginatedQuery(
    api.messages.getSavedFilesByChatId,
    active ? { chatId } : "skip",
    { initialNumItems: SAVED_CHAT_FILES_PAGE_SIZE },
  );
  // Empty pages still return CanLoadMore until the cursor is exhausted.
  useEffect(() => {
    if (active && status === "CanLoadMore")
      loadMore(SAVED_CHAT_FILES_PAGE_SIZE);
  }, [active, status, loadMore]);
  const entries = active ? (results as SavedFileEntry[]) : NO_ENTRIES;
  const merged = useMemo(
    () => mergeSavedFileMessages(messages, entries),
    [messages, entries],
  );
  return {
    messages: merged,
    loading: active && status !== "Exhausted",
  };
}
