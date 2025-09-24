export type ConversationDraft = {
  id: string;
  content: string;
  timestamp: number;
};

export type ConversationDraftStore = {
  drafts: Array<ConversationDraft>;
  userId?: string;
};

export const CONVERSATION_DRAFTS_STORAGE_KEY = "conversation_drafts";
export const NULL_THREAD_DRAFT_ID = "null_thread";
export const CHAT_MODE_STORAGE_KEY = "chat_mode";

const isBrowser = (): boolean => typeof window !== "undefined";

export const readDraftStore = (): ConversationDraftStore => {
  if (!isBrowser()) return { drafts: [] };
  try {
    const raw = window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY);
    if (!raw) return { drafts: [] };
    const parsed = JSON.parse(raw);
    const drafts = Array.isArray(parsed?.drafts) ? parsed.drafts : [];
    const userId =
      typeof parsed?.userId === "string" ? parsed.userId : undefined;
    return { drafts, userId };
  } catch {
    return { drafts: [] };
  }
};

export const writeDraftStore = (store: ConversationDraftStore): void => {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(
      CONVERSATION_DRAFTS_STORAGE_KEY,
      JSON.stringify({ drafts: store.drafts, userId: store.userId }),
    );
  } catch {
    // ignore
  }
};

export const readChatMode = (): "ask" | "agent" | null => {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(CHAT_MODE_STORAGE_KEY);
    if (raw === "ask" || raw === "agent") return raw;
    return null;
  } catch {
    return null;
  }
};

export const writeChatMode = (mode: "ask" | "agent"): void => {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(CHAT_MODE_STORAGE_KEY, mode);
  } catch {
    // ignore
  }
};

export const getDraftContentById = (id: string): string | null => {
  const store = readDraftStore();
  const entry = store.drafts.find((d) => d.id === id);
  return entry ? entry.content : null;
};

export const upsertDraft = (
  id: string,
  content: string,
  timestamp?: number,
): void => {
  const store = readDraftStore();
  const idx = store.drafts.findIndex((d) => d.id === id);
  const entry: ConversationDraft = {
    id,
    content,
    timestamp: typeof timestamp === "number" ? timestamp : Date.now(),
  };
  if (idx >= 0) {
    store.drafts[idx] = entry;
  } else {
    store.drafts.push(entry);
  }
  writeDraftStore(store);
};

export const removeDraft = (id: string): void => {
  const store = readDraftStore();
  const nextDrafts = store.drafts.filter((d) => d.id !== id);
  writeDraftStore({ ...store, drafts: nextDrafts });
};

export const getDrafts = (): Array<ConversationDraft> =>
  readDraftStore().drafts;

export const getUserIdFromDrafts = (): string | undefined =>
  readDraftStore().userId;

export const setUserIdInDrafts = (userId: string): void => {
  const store = readDraftStore();
  writeDraftStore({ ...store, userId });
};

export const clearAllDrafts = (): void => {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(CONVERSATION_DRAFTS_STORAGE_KEY);
  } catch {
    // ignore
  }
};
