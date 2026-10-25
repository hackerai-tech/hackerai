"use client";

import useSWR from "swr";
import { PanelRight } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

export function ComputerPanelToggle({ chatId }: { chatId?: string }) {
  const { sidebarOpen, setSidebarOpen, closeSidebar } = useGlobalState();
  const enabled = useWorkspaceFilesEnabled(chatId);
  if (!enabled || !chatId) return null;
  const label = sidebarOpen ? "Close Computer" : "Open Computer";
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() =>
              sidebarOpen ? closeSidebar() : setSidebarOpen(true)
            }
            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${sidebarOpen ? "bg-muted text-foreground" : "text-muted-foreground"}`}
            aria-label={label}
            aria-expanded={sidebarOpen}
          >
            <PanelRight size={18} aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent>{label} — activity and files</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
