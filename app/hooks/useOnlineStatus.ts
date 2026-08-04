"use client";

import { useSyncExternalStore } from "react";

const getOnlineSnapshot = () =>
  typeof navigator === "undefined" ? true : navigator.onLine;

const subscribeToOnlineStatus = (onStoreChange: () => void) => {
  window.addEventListener("online", onStoreChange);
  window.addEventListener("offline", onStoreChange);

  return () => {
    window.removeEventListener("online", onStoreChange);
    window.removeEventListener("offline", onStoreChange);
  };
};

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribeToOnlineStatus,
    getOnlineSnapshot,
    () => true,
  );
}
