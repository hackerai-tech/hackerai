"use client";

import { useCallback, useSyncExternalStore } from "react";

export const CONTEXT_DETAILS_STORAGE_KEY = "show_context_details";

const listeners = new Set<() => void>();
// This tab's choice after a failed write. Reads may still succeed and return
// the stale stored value, so this wins until a write succeeds again.
let unsavedValue: boolean | undefined;

const readPreference = (): boolean => {
  if (unsavedValue !== undefined) return unsavedValue;
  try {
    return window.localStorage.getItem(CONTEXT_DETAILS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
};

const getServerPreference = () => false;

const subscribe = (onStoreChange: () => void) => {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === CONTEXT_DETAILS_STORAGE_KEY || event.key === null) {
      // Another tab saved a newer choice; follow it.
      unsavedValue = undefined;
      onStoreChange();
    }
  };
  listeners.add(onStoreChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", handleStorage);
  };
};

const writePreference = (enabled: boolean) => {
  try {
    if (enabled) {
      window.localStorage.setItem(CONTEXT_DETAILS_STORAGE_KEY, "true");
    } else {
      window.localStorage.removeItem(CONTEXT_DETAILS_STORAGE_KEY);
    }
    unsavedValue = undefined;
  } catch {
    // Storage is disabled or full; keep the choice for this tab.
    unsavedValue = enabled;
  }
  listeners.forEach((listener) => listener());
};

/** Display-only, device-local choice. Off unless the user turns it on. */
export function useContextDetailsPreference(): [
  boolean,
  (enabled: boolean) => void,
] {
  const enabled = useSyncExternalStore(
    subscribe,
    readPreference,
    getServerPreference,
  );
  const setEnabled = useCallback((next: boolean) => writePreference(next), []);
  return [enabled, setEnabled];
}
