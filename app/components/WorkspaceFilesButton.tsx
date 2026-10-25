"use client";

import useSWR from "swr";
import { FolderOpen } from "lucide-react";
import { useGlobalState } from "../contexts/GlobalState";

export function useWorkspaceFilesEnabled(chatId?: string): boolean {
  const { data } = useSWR(
    chatId ? `/api/workspace-files?chatId=${encodeURIComponent(chatId)}` : null,
    async (url: string) => {
      const response = await fetch(url);
      return response.ok ? response.json() : { enabled: false };
    },
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  return data?.enabled === true;
}

export function WorkspaceFilesButton({ chatId }: { chatId?: string }) {
  const { openSidebar } = useGlobalState();
  const enabled = useWorkspaceFilesEnabled(chatId);
  if (!enabled || !chatId) return null;
  return (
    <button
      type="button"
      onClick={() =>
        openSidebar({
          kind: "workspace-files",
          chatId,
          toolCallId: `workspace-files:${chatId}`,
        })
      }
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="Open workspace files"
    >
      <FolderOpen size={16} />
      Files
    </button>
  );
}
