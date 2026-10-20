"use client";

import { useMemo } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { Monitor } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useGlobalState } from "@/app/contexts/GlobalState";
import {
  extractAllSidebarContent,
  type Message,
} from "@/lib/utils/sidebar-utils";
import { isSidebarTerminal } from "@/types/chat";

/** Keep the live browser discoverable without requiring a tool-history click. */
export function BrowserHandoffEntry({
  chatId,
  messages,
}: {
  chatId: string;
  messages: Message[];
}) {
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

  if (sidebarOpen || !session || !browserTool) return null;

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
          onClick={() => openSidebar(browserTool)}
          className="min-h-11 shrink-0 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open browser
        </button>
      </div>
    </div>
  );
}
