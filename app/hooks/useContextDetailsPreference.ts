"use client";

import { useCallback, useSyncExternalStore } from "react";

export const CONTEXT_DETAILS_STORAGE_KEY = "show_context_details";

const listeners = new Set<() => void>();
// Keeps the choice for this tab when browser storage is unavailable.
let memoryValue = false;

const readPreference = (): boolean => {
  try {
    return window.localStorage.getItem(CONTEXT_DETAILS_STORAGE_KEY) === "true";
  } catch {
    return memoryValue;
  }
};

const getServerPreference = () => false;

const subscribe = (onStoreChange: () => void) => {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === CONTEXT_DETAILS_STORAGE_KEY || event.key === null) {
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
  memoryValue = enabled;
  try {
    if (enabled) {
      window.localStorage.setItem(CONTEXT_DETAILS_STORAGE_KEY, "true");
    } else {
      window.localStorage.removeItem(CONTEXT_DETAILS_STORAGE_KEY);
    }
  } catch {
    // Browser storage can be disabled; keep the in-memory choice.
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
