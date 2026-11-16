"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import {
  CHAT_STARTERS_DEFINITION_VERSION,
  type ChatStarterPresentation,
} from "@/lib/chat/starter-prompts";
import type { ChatMode } from "@/types/chat";

type ChatStartersContextValue = {
  userId: string;
  /** Server flag decision for this exact user; false while unresolved. */
  enabled: boolean;
  /** Null until history or a first-submission marker decides it. */
  presentation: ChatStarterPresentation | null;
  markFirstSubmission: () => void;
  recordExposure: (
    mode: ChatMode,
    presentation: ChatStarterPresentation,
  ) => void;
};

/** Minimal views of the layout's existing history subscriptions. */
type ChatHistoryList = { status: string; results?: readonly unknown[] };
type ProjectHistoryList = { results?: readonly unknown[] };

const ChatStartersContext = createContext<ChatStartersContextValue | null>(
  null,
);

const firstSubmissionKey = (userId: string) =>
  `hackerai:chat-starters:first-submission:v1:${userId}`;

const readFirstSubmission = (userId: string): boolean => {
  try {
    return window.localStorage.getItem(firstSubmissionKey(userId)) === "1";
  } catch {
    return false;
  }
};

const writeFirstSubmission = (userId: string) => {
  try {
    window.localStorage.setItem(firstSubmissionKey(userId), "1");
  } catch {
    // In-memory state still collapses starters for this session.
  }
};

/**
 * Owns per-account starter availability: the server flag, whether the account
 * already has history (from the layout's existing lists), and a local marker
 * so starters collapse right after the first accepted submission.
 */
export function ChatStartersProvider({
  userId,
  chats,
  projects,
  children,
}: {
  userId: string | null | undefined;
  chats: ChatHistoryList;
  projects: ProjectHistoryList;
  children: ReactNode;
}) {
  const [flag, setFlag] = useState<{ userId: string; enabled: boolean }>();
  useEffect(() => {
    if (!userId) return;
    const abort = new AbortController();
    fetch("/api/chat-starters", { signal: abort.signal, cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { enabled?: unknown } | null) => {
        if (!abort.signal.aborted)
          setFlag({ userId, enabled: data?.enabled === true });
      })
      .catch(() => {
        if (!abort.signal.aborted) setFlag({ userId, enabled: false });
      });
    return () => abort.abort();
  }, [userId]);

  const [submittedUserId, setSubmittedUserId] = useState<string | null>(null);
  const storedFirstSubmission = useMemo(
    () =>
      !!userId && typeof window !== "undefined" && readFirstSubmission(userId),
    [userId],
  );

  const hasHistory =
    (chats.results?.length ?? 0) > 0 || (projects.results?.length ?? 0) > 0;
  const historyResolved =
    chats.status !== "LoadingFirstPage" && projects.results !== undefined;
  const presentation: ChatStarterPresentation | null = !userId
    ? null
    : hasHistory || storedFirstSubmission || submittedUserId === userId
      ? "collapsed"
      : historyResolved
        ? "expanded"
        : null;

  const markFirstSubmission = useCallback(() => {
    if (!userId) return;
    writeFirstSubmission(userId);
    setSubmittedUserId(userId);
  }, [userId]);

  const exposedRef = useRef(new Set<string>());
  const recordExposure = useCallback(
    (mode: ChatMode, shown: ChatStarterPresentation) => {
      if (!userId) return;
      const key = `${userId}:${mode}:${shown}`;
      if (exposedRef.current.has(key)) return;
      if (
        captureAuthenticatedEvent("chat_starters_exposed", {
          definition_version: CHAT_STARTERS_DEFINITION_VERSION,
          mode,
          presentation: shown,
        })
      )
        exposedRef.current.add(key);
    },
    [userId],
  );

  const enabled = !!userId && flag?.userId === userId && flag.enabled;
  const value = useMemo(
    () =>
      userId
        ? {
            userId,
            enabled,
            presentation,
            markFirstSubmission,
            recordExposure,
          }
        : null,
    [userId, enabled, presentation, markFirstSubmission, recordExposure],
  );

  return (
    <ChatStartersContext.Provider value={value}>
      {children}
    </ChatStartersContext.Provider>
  );
}

/** Null outside the authenticated chat layout, which keeps starters off. */
export function useChatStarters() {
  return useContext(ChatStartersContext);
}
