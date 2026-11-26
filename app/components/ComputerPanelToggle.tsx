"use client";

import { useEffect, useRef } from "react";
import useSWR from "swr";
import { Folder } from "lucide-react";
import { useGlobalState } from "../contexts/GlobalState";
import { trackWorkspaceFiles } from "@/lib/analytics/workspace-files";

export function useWorkspaceFilesEnabled(chatId?: string): boolean {
  const { data } = useSWR(
    chatId ? `/api/workspace-files?chatId=${encodeURIComponent(chatId)}` : null,
    async (url: string) => {
      const response = await fetch(url);
      if (response.status >= 500 || response.status === 429) {
        throw new Error("Computer availability temporarily unavailable");
      }
      return response.ok ? response.json() : { enabled: false };
    },
    {
      revalidateOnFocus: false,
      errorRetryCount: 2,
      errorRetryInterval: 2_000,
    },
  );
  return data?.enabled === true;
}

/**
 * Header entry to the Computer panel. Always opens Files / This chat rather
 * than toggling; Activity and opened file tabs stay inside the panel.
 */
export function WorkspaceFilesShortcut({ chatId }: { chatId?: string }) {
  const { sidebarOpen, openSidebar } = useGlobalState();
  const enabled = useWorkspaceFilesEnabled(chatId);
  const shown = enabled && !!chatId;

  // Refs survive effect replay, so each chat reports once per mounted header.
  const exposedChat = useRef<string | null>(null);
  useEffect(() => {
    if (
      shown &&
      exposedChat.current !== chatId &&
      trackWorkspaceFiles("workspace_files_header_exposed", {})
    ) {
      exposedChat.current = chatId;
    }
  }, [shown, chatId]);

  if (!shown || !chatId) return null;
  return (
    <button
      type="button"
      aria-label="Open files"
      data-testid="files-shortcut-button"
      onClick={() => {
        trackWorkspaceFiles("workspace_files_header_clicked", {});
        openSidebar({
          kind: "workspace-files",
          chatId,
          toolCallId: `workspace-files:${chatId}`,
        });
      }}
      className={`inline-flex h-[34px] shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:-my-1.5 max-md:h-11 max-md:w-11 max-md:px-0 ${sidebarOpen ? "bg-muted" : ""}`}
    >
      <Folder
        className="h-4 w-4 -ms-0.5 max-md:ms-0 max-md:size-5"
        aria-hidden
      />
      <span className="max-md:hidden">Files</span>
    </button>
  );
}
