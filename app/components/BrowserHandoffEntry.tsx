"use client";

import { useEffect, useMemo, useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { MousePointerClick, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { effectiveBrowserHandoffState } from "@/convex/lib/browserHandoffState";
import { useGlobalState } from "@/app/contexts/GlobalState";
import {
  extractAllSidebarContent,
  type Message,
} from "@/lib/utils/sidebar-utils";
import { isSidebarTerminal } from "@/types/chat";

/** Show composer attention only when the browser needs human input. */
export function BrowserHandoffEntry({
  chatId,
  messages,
  persistedMessages,
}: {
  chatId: string;
  messages: Message[];
  persistedMessages?: Message[];
}) {
  const [preference, setPreference] = useState<{
    chatId: string;
    dismissedAttention: string | null;
  } | null>(null);
  const storageKey = `browser-reminder:v1:${chatId}`;
  useEffect(() => {
    const readPreference = () => {
      let dismissedAttention: string | null = null;
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
        dismissedAttention =
          typeof saved?.dismissedAttention === "string"
            ? saved.dismissedAttention
            : null;
      } catch {
        // Storage may be unavailable. Dismissal still works for this mount.
      }
      setPreference({ chatId, dismissedAttention });
    };
    readPreference();
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) readPreference();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [chatId, storageKey]);

  const { isAuthenticated } = useConvexAuth();
  const { sidebarOpen, sidebarContent, openSidebar } = useGlobalState();
  const session = useQuery(
    api.browserHandoffs.getForUser,
    isAuthenticated && chatId ? { chatId, agentId: "parent" } : "skip",
  );
  const [now, setNow] = useState(Date.now);
  const recoveryAt =
    session?.state === "human" || session?.state === "claiming"
      ? (session.grantExpiresAt ?? 0)
      : session?.state === "resuming"
        ? session.updatedAt + 30_000
        : null;
  const expiresAt = session?.expiresAt;
  useEffect(() => {
    // Convex queries do not rerun just because a control lease expires. After
    // a reload, surface recovery even when no browser viewer is mounted.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      const currentTime = Date.now();
      setNow(currentTime);
      const deadlines = [recoveryAt, expiresAt].filter(
        (value): value is number => value != null && value > currentTime,
      );
      if (deadlines.length > 0)
        timer = setTimeout(wake, Math.min(...deadlines) - currentTime);
    };
    wake();
    return () => clearTimeout(timer);
  }, [recoveryAt, expiresAt]);
  const state = session
    ? effectiveBrowserHandoffState(
        {
          state: session.state,
          grant_expires_at: session.grantExpiresAt ?? undefined,
          updated_at: session.updatedAt,
        },
        now,
      )
    : null;
  const browserTool = useMemo(() => {
    // A saved handoff can arrive before its live tool chunk. Keep takeover
    // reachable without replacing the SDK's in-flight messages.
    for (const source of [messages, persistedMessages]) {
      if (!source) continue;
      const tool = extractAllSidebarContent(source)
        .reverse()
        .find(
          (content) =>
            isSidebarTerminal(content) &&
            /\bagent-browser\b/.test(content.command),
        );
      if (tool) return tool;
    }
  }, [messages, persistedMessages]);

  const showingGoalEditor =
    sidebarContent &&
    "kind" in sidebarContent &&
    sidebarContent.kind === "goal";
  if (
    (sidebarOpen && !showingGoalEditor) ||
    !session ||
    session.expiresAt <= now ||
    !browserTool ||
    preference?.chatId !== chatId
  )
    return null;

  const attentionKey =
    state === "waiting" || state === "recovery"
      ? `${session.sessionId}:${state}:${session.updatedAt}`
      : null;
  const needsAttention =
    attentionKey !== null && preference.dismissedAttention !== attentionKey;

  const dismissAttention = () => {
    setPreference({ chatId, dismissedAttention: attentionKey });
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ dismissedAttention: attentionKey }),
      );
    } catch {
      // Dismissal still works for this mount when storage is blocked.
    }
  };

  if (!needsAttention) return null;

  return (
    <div className="mb-2 w-full">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background p-3 shadow-sm sm:flex-nowrap sm:gap-3">
        <MousePointerClick
          size={18}
          className="shrink-0 text-muted-foreground"
          aria-hidden
        />
        <div className="min-w-0 flex-1 text-sm">
          <p role="status" className="font-medium">
            {state === "recovery"
              ? "Browser takeover needs attention"
              : "Agent needs your input"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Take control to complete this step, then continue the Agent.
          </p>
        </div>
        <button
          type="button"
          onClick={dismissAttention}
          aria-label="Dismiss browser takeover prompt"
          className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:order-last sm:min-h-9 sm:min-w-9"
        >
          <X size={16} aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => {
            openSidebar({
              ...browserTool,
              browserTakeoverRequest: {
                requestId: crypto.randomUUID(),
                sessionId: session.sessionId,
              },
            });
          }}
          className="min-h-11 w-full shrink-0 rounded-full bg-foreground px-4 text-sm font-medium text-background hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9 sm:w-auto"
        >
          Take control
        </button>
      </div>
    </div>
  );
}
