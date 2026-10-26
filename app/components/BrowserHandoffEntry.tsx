"use client";

import { useEffect, useMemo, useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { Monitor, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useGlobalState } from "@/app/contexts/GlobalState";
import {
  extractAllSidebarContent,
  type Message,
} from "@/lib/utils/sidebar-utils";
import { isSidebarTerminal } from "@/types/chat";

type ReminderPreference = {
  chatId: string;
  browserDiscovered: boolean;
  dismissedAttention: string | null;
  acknowledgedSession: string | null;
};

const discoveryKey = "browser-reminder:discovered:v1";

/** Passive discovery appears once; a new handoff can still request attention. */
export function BrowserHandoffEntry({
  chatId,
  messages,
}: {
  chatId: string;
  messages: Message[];
}) {
  const [preference, setPreference] = useState<ReminderPreference | null>(null);
  const storageKey = `browser-reminder:v1:${chatId}`;
  useEffect(() => {
    const readPreference = () => {
      let browserDiscovered = false;
      let discoveredInChat = false;
      let dismissedAttention: string | null = null;
      let acknowledgedSession: string | null = null;
      try {
        browserDiscovered = localStorage.getItem(discoveryKey) === "true";
      } catch {
        // Storage may be unavailable. Dismissal still works for this mount.
      }
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
        discoveredInChat =
          saved?.availableHidden === true || saved?.browserDiscovered === true;
        acknowledgedSession =
          typeof saved?.acknowledgedSession === "string"
            ? saved.acknowledgedSession
            : null;
        dismissedAttention =
          typeof saved?.dismissedAttention === "string"
            ? saved.dismissedAttention
            : null;
      } catch {
        // Storage may be unavailable. Dismissal still works for this mount.
      }
      if (discoveredInChat && !browserDiscovered) {
        browserDiscovered = true;
        try {
          localStorage.setItem(discoveryKey, "true");
        } catch {
          // The per-chat preference still hides the notice in this chat.
        }
      }
      setPreference({
        chatId,
        browserDiscovered,
        dismissedAttention,
        acknowledgedSession,
      });
    };
    readPreference();
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === storageKey ||
        event.key === discoveryKey ||
        event.key === null
      )
        readPreference();
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

  const passiveVisible =
    !sidebarOpen &&
    !!session &&
    !!browserTool &&
    preference?.chatId === chatId &&
    session.state === "agent" &&
    !preference.browserDiscovered;

  useEffect(() => {
    if (!passiveVisible) return;
    try {
      localStorage.setItem(discoveryKey, "true");
    } catch {
      // Storage may be unavailable; the notice remains visible this mount.
    }
  }, [passiveVisible]);

  if (sidebarOpen || !session || !browserTool || preference?.chatId !== chatId)
    return null;

  // Only a new wait request or recovery problem should interrupt an acknowledged
  // session. Claiming, human control, and resuming belong to the same takeover.
  const attentionKey =
    session.state === "waiting" || session.state === "recovery"
      ? `${session.sessionId}:${session.state}:${session.updatedAt}`
      : null;
  if (
    attentionKey
      ? preference.dismissedAttention === attentionKey
      : session.state === "agent"
        ? preference.browserDiscovered
        : preference.acknowledgedSession === session.sessionId
  )
    return null;

  const dismiss = () => {
    const next = {
      chatId,
      browserDiscovered: true,
      dismissedAttention: attentionKey,
      acknowledgedSession: session.sessionId,
    };
    setPreference(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Storage may be unavailable. Dismissal still works for this mount.
    }
    try {
      localStorage.setItem(discoveryKey, "true");
    } catch {
      // Never prevent opening the browser when storage is blocked or full.
    }
  };

  const status =
    session.state === "waiting"
      ? "Waiting for you"
      : session.state === "claiming"
        ? "Pausing Agent…"
        : session.state === "resuming"
          ? "Returning control to Agent…"
          : session.state === "human" || session.state === "recovery"
            ? "Agent paused for browser takeover"
            : "Agent browser available";

  return (
    <div className="mx-auto mb-1.5 w-full max-w-[800px] px-4">
      <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-2.5 py-1 shadow-sm sm:gap-2.5">
        <Monitor
          size={16}
          className="shrink-0 text-muted-foreground"
          aria-hidden
        />
        <div className="min-w-0 flex-1 text-xs sm:text-sm">
          <p role="status" className="truncate font-medium">
            {status}
          </p>
          <p className="sr-only">
            Open the browser to view it or take control.
          </p>
        </div>
        <button
          type="button"
          aria-label="Open browser"
          onClick={() => {
            dismiss();
            openSidebar(browserTool);
          }}
          className="min-h-11 shrink-0 rounded-full bg-foreground px-3 text-xs font-medium text-background hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9 sm:text-sm"
        >
          Open<span className="hidden min-[360px]:inline"> browser</span>
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Hide browser reminder"
          title="Dismiss this notice. New handoff requests will still appear."
          className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9 sm:min-w-9"
        >
          <X size={16} aria-hidden />
        </button>
      </div>
    </div>
  );
}
