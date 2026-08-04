"use client";

import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let verifiedOnlineOverride: boolean | null = null;

const getBrowserOnlineSnapshot = () =>
  typeof navigator === "undefined" ? true : navigator.onLine;

export const getOnlineStatusSnapshot = () =>
  verifiedOnlineOverride ?? getBrowserOnlineSnapshot();

const emitOnlineStatusChange = () => {
  listeners.forEach((listener) => listener());
};

const handleBrowserOnlineStatusChange = () => {
  verifiedOnlineOverride = null;
  emitOnlineStatusChange();
};

const subscribeToOnlineStatus = (onStoreChange: () => void) => {
  listeners.add(onStoreChange);
  if (listeners.size === 1) {
    window.addEventListener("online", handleBrowserOnlineStatusChange);
    window.addEventListener("offline", handleBrowserOnlineStatusChange);
  }

  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) {
      window.removeEventListener("online", handleBrowserOnlineStatusChange);
      window.removeEventListener("offline", handleBrowserOnlineStatusChange);
      verifiedOnlineOverride = null;
    }
  };
};

export async function reconnectOnlineStatus(): Promise<boolean> {
  try {
    const response = await fetch("/api/health/connectivity", {
      method: "HEAD",
      cache: "no-store",
      credentials: "same-origin",
    });
    verifiedOnlineOverride = response.ok;
  } catch {
    verifiedOnlineOverride = false;
  }

  emitOnlineStatusChange();
  return verifiedOnlineOverride;
}

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribeToOnlineStatus,
    getOnlineStatusSnapshot,
    () => true,
  );
}
