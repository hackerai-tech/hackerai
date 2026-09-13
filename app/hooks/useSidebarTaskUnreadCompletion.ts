"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  getServerSidebarTaskLastVisitedAt,
  readSidebarTaskLastVisitedAt,
  subscribeSidebarTaskLastVisitedAt,
} from "@/lib/utils/client-storage";

export function useSidebarTaskUnreadCompletion({
  taskId,
  lastRunFinishedAt,
  isActive,
}: {
  taskId: string;
  lastRunFinishedAt?: number;
  isActive: boolean;
}): boolean {
  const store = useMemo(
    () => ({
      getSnapshot: () => readSidebarTaskLastVisitedAt(taskId),
      subscribe: (onStoreChange: () => void) =>
        subscribeSidebarTaskLastVisitedAt(taskId, onStoreChange),
    }),
    [taskId],
  );
  const lastVisitedAt = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    getServerSidebarTaskLastVisitedAt,
  );

  return Boolean(
    !isActive &&
    lastRunFinishedAt !== undefined &&
    lastVisitedAt !== undefined &&
    lastRunFinishedAt > lastVisitedAt,
  );
}
