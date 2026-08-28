"use client";

import { useMediaQuery } from "@/hooks/use-media-query";

const COMPACT_TASK_SIDEBAR_QUERY = "(min-width: 768px) and (max-width: 1239px)";
const COMPUTER_SIDEBAR_OVERLAY_QUERY = "(max-width: 949px)";

export function useCompactTaskSidebar(): boolean {
  return useMediaQuery(COMPACT_TASK_SIDEBAR_QUERY);
}

export function useComputerSidebarOverlay(): boolean {
  return useMediaQuery(COMPUTER_SIDEBAR_OVERLAY_QUERY);
}
