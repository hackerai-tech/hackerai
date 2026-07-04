"use client";

import { usePaginatedQuery, useMutation, useConvexAuth } from "convex/react";
import { api } from "@/convex/_generated/api";

/**
 * Wrapper around usePaginatedQuery for user chats.
 * Auth is enforced server-side by Convex.
 */
export const useChats = (shouldFetch = true) => {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const shouldRunQuery = shouldFetch && !isLoading && isAuthenticated;
  const query = usePaginatedQuery(
    api.chats.getUserChats,
    shouldRunQuery ? {} : "skip",
    {
      initialNumItems: 28,
    },
  );

  if (shouldFetch && (isLoading || !isAuthenticated)) {
    return {
      ...query,
      results: [],
      status: "LoadingFirstPage" as const,
    };
  }

  return query;
};

export const usePinChat = () => useMutation(api.chats.pinChat);
export const useUnpinChat = () => useMutation(api.chats.unpinChat);
