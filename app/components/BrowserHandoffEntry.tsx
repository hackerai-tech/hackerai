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
  availableHidden: boolean;
  dismissedAttention: string | null;
  acknowledgedSession: string | null;
};

/** Passive discovery stays dismissed; a new handoff can still request attention. */
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
      let availableHidden = false;
      let dismissedAttention: string | null = null;
      let acknowledgedSession: string | null = null;
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
        availableHidden = saved?.availableHidden === true;
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
      setPreference({
        chatId,
        availableHidden,
        dismissedAttention,
        acknowledgedSession,
      });
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
        ? preference.availableHidden
        : preference.acknowledgedSession === session.sessionId
  )
    return null;

  const dismiss = () => {
    const next = {
      chatId,
      availableHidden: true,
      dismissedAttention: attentionKey,
      acknowledgedSession: session.sessionId,
    };
    setPreference(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
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
    <div className="mx-auto mb-2 w-full max-w-[800px] px-4">
      <div className="flex items-center gap-3 rounded-2xl border border-border bg-background px-3 py-2.5 shadow-sm">
        <Monitor
          size={18}
          className="shrink-0 text-muted-foreground"
          aria-hidden
        />
        <div className="min-w-0 flex-1 text-sm">
          <p role="status" className="font-medium">
            {status}
          </p>
          <p className="text-xs text-muted-foreground">
            Open the browser to view it or take control.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            dismiss();
            openSidebar(browserTool);
          }}
          className="min-h-11 shrink-0 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open browser
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Hide browser reminder"
          title="Hide browser reminders for this chat. New handoff requests will still appear."
          className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X size={16} aria-hidden />
        </button>
      </div>
    </div>
  );
}
