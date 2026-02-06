"use client";

import { useEffect } from "react";
import { usePaginatedQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useGlobalState } from "../contexts/GlobalState";

/**
 * Custom hook to handle chat fetching and state management
 * Can be used by multiple components to ensure chats are loaded when needed
 */
export const useChats = (shouldFetch: boolean = true) => {
  const { user } = useAuth();
  const { setChats } = useGlobalState();

  // Get user's chats with pagination
  const paginatedChats = usePaginatedQuery(
    api.chats.getUserChats,
    user && shouldFetch ? {} : "skip",
    { initialNumItems: 28 },
  );

  // Update global chats state when chats change
  useEffect(() => {
    if (paginatedChats.results) {
      setChats(paginatedChats.results);
    }
  }, [paginatedChats.results, setChats]);

  return paginatedChats;
};

export const usePinChat = () => useMutation(api.chats.pinChat);
export const useUnpinChat = () => useMutation(api.chats.unpinChat);
