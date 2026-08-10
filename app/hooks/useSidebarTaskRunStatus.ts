"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  getServerSidebarTaskRunStatus,
  readSidebarTaskRunStatus,
  reconcileSidebarTaskRunStatus,
  subscribeSidebarTaskRunStatus,
  type SidebarTaskRunStatus,
} from "@/lib/utils/client-storage";

export function useSidebarTaskRunStatus({
  taskId,
  isRunning,
  isActive,
}: {
  taskId: string;
  isRunning: boolean;
  isActive: boolean;
}): SidebarTaskRunStatus | undefined {
  const store = useMemo(
    () => ({
      getSnapshot: () => readSidebarTaskRunStatus(taskId),
      subscribe: (onStoreChange: () => void) =>
        subscribeSidebarTaskRunStatus(taskId, onStoreChange),
    }),
    [taskId],
  );
  const status = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    getServerSidebarTaskRunStatus,
  );

  useEffect(() => {
    reconcileSidebarTaskRunStatus({ taskId, isRunning, isActive });
  }, [isActive, isRunning, taskId]);

  return status;
}
