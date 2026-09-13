"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface ChatRoutePresentationContextValue {
  hasResolvedInitialPresentation: boolean;
  markInitialPresentationResolved: () => void;
}

const ChatRoutePresentationContext =
  createContext<ChatRoutePresentationContextValue | null>(null);

export function ChatRoutePresentationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [hasResolvedInitialPresentation, setHasResolvedInitialPresentation] =
    useState(false);
  const markInitialPresentationResolved = useCallback(() => {
    setHasResolvedInitialPresentation(true);
  }, []);
  const value = useMemo(
    () => ({
      hasResolvedInitialPresentation,
      markInitialPresentationResolved,
    }),
    [hasResolvedInitialPresentation, markInitialPresentationResolved],
  );

  return (
    <ChatRoutePresentationContext.Provider value={value}>
      {children}
    </ChatRoutePresentationContext.Provider>
  );
}

export function useChatRoutePresentation() {
  const context = useContext(ChatRoutePresentationContext);
  if (!context) {
    throw new Error(
      "useChatRoutePresentation must be used within a ChatRoutePresentationProvider",
    );
  }
  return context;
}
