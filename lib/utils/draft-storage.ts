interface ChatDraft {
  id: string; // chat ID or "null_thread" for new chat
  content: string;
  timestamp: number;
}

interface DraftStorage {
  drafts: ChatDraft[];
  userId: string;
}

const DRAFT_STORAGE_KEY = "chat_drafts";

// Auto-save configuration
const AUTO_SAVE_DELAY = 1000; // 1 second debounce
let autoSaveTimeout: NodeJS.Timeout | null = null;
let currentUserId: string | null = null;

export const draftStorage = {
  /**
   * Save a draft for a specific chat
   */
  saveDraft: (chatId: string | null, content: string, userId: string): void => {
    const threadId = chatId || "null_thread";

    if (!content.trim()) {
      // For null_thread (new chat), don't remove empty drafts - they might be restored later
      // For specific chats, remove empty drafts since they're not useful
      if (threadId !== "null_thread") {
        draftStorage.removeDraft(chatId, userId);
      }
      return;
    }

    try {
      const existingStorage = draftStorage.getStorage();

      // Validate user - only save if it's the same user
      if (existingStorage && existingStorage.userId !== userId) {
        // Different user, clear storage and start fresh
        localStorage.removeItem(DRAFT_STORAGE_KEY);
      }

      const currentStorage: DraftStorage =
        existingStorage?.userId === userId
          ? existingStorage
          : { drafts: [], userId };

      // Find existing draft for this chat
      const existingDraftIndex = currentStorage.drafts.findIndex(
        (draft) => draft.id === threadId,
      );

      const newDraft: ChatDraft = {
        id: threadId,
        content: content.trim(),
        timestamp: Date.now(),
      };

      if (existingDraftIndex >= 0) {
        // Update existing draft
        currentStorage.drafts[existingDraftIndex] = newDraft;
      } else {
        // Add new draft
        currentStorage.drafts.push(newDraft);
      }

      // Limit to 50 most recent drafts to prevent localStorage bloat
      if (currentStorage.drafts.length > 50) {
        currentStorage.drafts = currentStorage.drafts
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 50);
      }

      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(currentStorage));
    } catch (error) {
      console.warn("Failed to save draft to localStorage:", error);
    }
  },

  /**
   * Get a draft for a specific chat
   */
  getDraft: (chatId: string | null, userId: string): string => {
    try {
      const threadId = chatId || "null_thread";
      const storage = draftStorage.getStorage();

      if (!storage || storage.userId !== userId) {
        return "";
      }

      const draft = storage.drafts.find((draft) => draft.id === threadId);
      return draft?.content || "";
    } catch (error) {
      console.warn("Failed to get draft from localStorage:", error);
      return "";
    }
  },

  /**
   * Remove a draft for a specific chat
   */
  removeDraft: (chatId: string | null, userId: string): void => {
    try {
      const threadId = chatId || "null_thread";
      const storage = draftStorage.getStorage();

      if (!storage || storage.userId !== userId) {
        return;
      }

      const updatedDrafts = storage.drafts.filter(
        (draft) => draft.id !== threadId,
      );

      if (updatedDrafts.length === 0) {
        // No drafts left, remove the entire storage
        localStorage.removeItem(DRAFT_STORAGE_KEY);
      } else {
        const updatedStorage: DraftStorage = {
          ...storage,
          drafts: updatedDrafts,
        };
        localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(updatedStorage));
      }
    } catch (error) {
      console.warn("Failed to remove draft from localStorage:", error);
    }
  },

  /**
   * Get all drafts for the current user
   */
  getAllDrafts: (userId: string): ChatDraft[] => {
    try {
      const storage = draftStorage.getStorage();

      if (!storage || storage.userId !== userId) {
        return [];
      }

      return storage.drafts.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      console.warn("Failed to get all drafts from localStorage:", error);
      return [];
    }
  },

  /**
   * Clear all drafts for the current user
   */
  clearAllDrafts: (): void => {
    try {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
    } catch (error) {
      console.warn("Failed to clear drafts from localStorage:", error);
    }
  },

  /**
   * Get the raw storage object
   */
  getStorage: (): DraftStorage | null => {
    try {
      const stored = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (!stored) return null;

      const parsed = JSON.parse(stored);

      // Validate the structure
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof parsed.userId === "string" &&
        Array.isArray(parsed.drafts)
      ) {
        return parsed;
      }

      return null;
    } catch (error) {
      console.warn("Failed to parse draft storage:", error);
      return null;
    }
  },

  /**
   * Auto-save with debouncing - call this on every input change
   */
  autoSave: (chatId: string | null, content: string, userId: string): void => {
    // Clear existing timeout
    if (autoSaveTimeout) {
      clearTimeout(autoSaveTimeout);
    }

    // Set new timeout for auto-save
    autoSaveTimeout = setTimeout(() => {
      draftStorage.saveDraft(chatId, content, userId);
    }, AUTO_SAVE_DELAY);
  },

  /**
   * Initialize draft system for a user and return current draft
   */
  initializeForUser: (userId: string, chatId: string | null): string => {
    currentUserId = userId;

    // Clean up old drafts on initialization
    draftStorage.cleanupOldDrafts(userId);

    // Return current draft for the chat
    return draftStorage.getDraft(chatId, userId);
  },

  /**
   * Clear any pending auto-save
   */
  clearPendingSave: (): void => {
    if (autoSaveTimeout) {
      clearTimeout(autoSaveTimeout);
      autoSaveTimeout = null;
    }
  },

  /**
   * Handle message submission - clears draft and pending save
   */
  onMessageSubmit: (chatId: string | null, userId: string): void => {
    draftStorage.clearPendingSave();
    draftStorage.removeDraft(chatId, userId);
  },

  /**
   * Handle chat switching - save current and load new
   */
  switchChat: (
    fromChatId: string | null,
    toChatId: string | null,
    currentInput: string,
    userId: string,
  ): string => {
    // Save current draft if there's content
    if (currentInput.trim()) {
      draftStorage.saveDraft(fromChatId, currentInput, userId);
    }

    // Load draft for new chat
    return draftStorage.getDraft(toChatId, userId);
  },

  /**
   * Clean up old drafts (older than 30 days)
   */
  cleanupOldDrafts: (userId: string): void => {
    try {
      const storage = draftStorage.getStorage();

      if (!storage || storage.userId !== userId) {
        return;
      }

      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const recentDrafts = storage.drafts.filter(
        (draft) => draft.timestamp > thirtyDaysAgo,
      );

      if (recentDrafts.length !== storage.drafts.length) {
        if (recentDrafts.length === 0) {
          localStorage.removeItem(DRAFT_STORAGE_KEY);
        } else {
          const updatedStorage: DraftStorage = {
            ...storage,
            drafts: recentDrafts,
          };
          localStorage.setItem(
            DRAFT_STORAGE_KEY,
            JSON.stringify(updatedStorage),
          );
        }
      }
    } catch (error) {
      console.warn("Failed to cleanup old drafts:", error);
    }
  },
};
