"use client";

import { useEffect, useMemo, useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { MousePointerClick, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
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
}: {
  chatId: string;
  messages: Message[];
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
  const { sidebarOpen, openSidebar } = useGlobalState();
  const session = useQuery(
    api.browserHandoffs.getForUser,
    isAuthenticated && chatId ? { chatId, agentId: "parent" } : "skip",
  );
  const browserTool = useMemo(
    () =>
      extractAllSidebarContent(messages)
        .reverse()
        .find(
          (content) =>
            isSidebarTerminal(content) &&
            /\bagent-browser\b/.test(content.command),
        ),
    [messages],
  );

  if (sidebarOpen || !session || !browserTool || preference?.chatId !== chatId)
    return null;

  const attentionKey =
    session.state === "waiting" || session.state === "recovery"
      ? `${session.sessionId}:${session.state}:${session.updatedAt}`
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
    <div className="mx-auto mb-2 w-full max-w-[800px] px-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background p-3 shadow-sm sm:flex-nowrap sm:gap-3">
        <MousePointerClick
          size={18}
          className="shrink-0 text-muted-foreground"
          aria-hidden
        />
        <div className="min-w-0 flex-1 text-sm">
          <p role="status" className="font-medium">
            {session.state === "recovery"
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
