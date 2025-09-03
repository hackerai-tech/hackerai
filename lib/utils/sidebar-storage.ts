/**
 * Sidebar localStorage utilities
 * Handles persistent storage for sidebar state with mobile-aware behavior
 */

// Storage keys for different sidebar contexts
export const STORAGE_KEYS = {
  CHAT_SIDEBAR: "chatSidebarOpen",
  MAIN_SIDEBAR: "sidebar_state",
} as const;

type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/**
 * Safely gets the saved sidebar state from localStorage
 * @param isMobile - Whether the current device is mobile
 * @param storageKey - The localStorage key to use (defaults to CHAT_SIDEBAR)
 * @returns The saved sidebar state (false for mobile, localStorage value for desktop)
 */
export const getSavedSidebarState = (
  isMobile: boolean,
  storageKey: StorageKey = STORAGE_KEYS.CHAT_SIDEBAR,
): boolean => {
  if (isMobile || typeof window === "undefined") {
    return false;
  }

  try {
    const saved = localStorage.getItem(storageKey);
    return saved ? JSON.parse(saved) : false;
  } catch {
    return false;
  }
};

/**
 * Safely saves the sidebar state to localStorage
 * @param state - The sidebar state to save
 * @param isMobile - Whether the current device is mobile
 * @param storageKey - The localStorage key to use (defaults to CHAT_SIDEBAR)
 */
export const saveSidebarState = (
  state: boolean,
  isMobile: boolean,
  storageKey: StorageKey = STORAGE_KEYS.CHAT_SIDEBAR,
): void => {
  if (!isMobile && typeof window !== "undefined") {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // Silently fail in production environments
      // This handles cases like:
      // - Incognito mode
      // - Storage quota exceeded
      // - Storage disabled by user/browser policy
    }
  }
};

/**
 * Clears the sidebar state from localStorage
 * @param storageKey - The localStorage key to clear (defaults to CHAT_SIDEBAR)
 */
export const clearSidebarState = (
  storageKey: StorageKey = STORAGE_KEYS.CHAT_SIDEBAR,
): void => {
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Silently fail in production
    }
  }
};

/**
 * Clears all sidebar states from localStorage
 * Useful for logout or complete reset operations
 */
export const clearAllSidebarStates = (): void => {
  Object.values(STORAGE_KEYS).forEach((key) => {
    clearSidebarState(key);
  });
};

/**
 * Creates sidebar storage utilities for a specific context
 * @param storageKey - The storage key to use
 * @returns Object with get, save, and clear functions for the specific context
 */
export const createSidebarStorage = (storageKey: StorageKey) => ({
  get: (isMobile: boolean) => getSavedSidebarState(isMobile, storageKey),
  save: (state: boolean, isMobile: boolean) =>
    saveSidebarState(state, isMobile, storageKey),
  clear: () => clearSidebarState(storageKey),
});

// Pre-configured storage utilities for common use cases
export const chatSidebarStorage = createSidebarStorage(
  STORAGE_KEYS.CHAT_SIDEBAR,
);
export const mainSidebarStorage = createSidebarStorage(
  STORAGE_KEYS.MAIN_SIDEBAR,
);
