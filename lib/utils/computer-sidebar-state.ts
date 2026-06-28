import type { SidebarContent } from "@/types/chat";

const STORAGE_KEY = "hackerai_computer_sidebar";
const STATE_TTL_MS = 6 * 60 * 60 * 1000;

export type PersistedComputerSidebarState = {
  chatId: string;
  toolCallId: string;
  followLive: boolean;
  updatedAt: number;
};

const isBrowser = (): boolean => typeof window !== "undefined";

const isPersistedComputerSidebarState = (
  value: unknown,
): value is PersistedComputerSidebarState => {
  if (!value || typeof value !== "object") return false;
  const record = value as PersistedComputerSidebarState;
  return (
    typeof record.chatId === "string" &&
    typeof record.toolCallId === "string" &&
    typeof record.followLive === "boolean" &&
    typeof record.updatedAt === "number"
  );
};

export const getSidebarToolCallId = (
  content: SidebarContent | null,
): string | null => {
  if (
    content &&
    "toolCallId" in content &&
    typeof content.toolCallId === "string" &&
    content.toolCallId.length > 0
  ) {
    return content.toolCallId;
  }

  return null;
};

export const getLatestSidebarToolCallId = (
  toolExecutions: SidebarContent[],
): string | null => {
  const latest = toolExecutions[toolExecutions.length - 1] ?? null;
  return getSidebarToolCallId(latest);
};

export const readPersistedComputerSidebarState = (
  now = Date.now(),
): PersistedComputerSidebarState | null => {
  if (!isBrowser()) return null;

  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedComputerSidebarState(parsed)) return null;
    if (now - parsed.updatedAt > STATE_TTL_MS) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
};

export const writePersistedComputerSidebarState = (
  state: PersistedComputerSidebarState,
): void => {
  if (!isBrowser()) return;

  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
};

export const clearPersistedComputerSidebarState = (chatId?: string): void => {
  if (!isBrowser()) return;

  try {
    if (chatId) {
      const current = readPersistedComputerSidebarState();
      if (current && current.chatId !== chatId) return;
    }
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
};

export const getRestoredComputerSidebarContent = ({
  chatId,
  persisted,
  toolExecutions,
  now = Date.now(),
}: {
  chatId: string;
  persisted: PersistedComputerSidebarState | null;
  toolExecutions: SidebarContent[];
  now?: number;
}): SidebarContent | null => {
  if (!persisted || persisted.chatId !== chatId) return null;
  if (now - persisted.updatedAt > STATE_TTL_MS) return null;
  if (toolExecutions.length === 0) return null;

  if (persisted.followLive) {
    return toolExecutions[toolExecutions.length - 1] ?? null;
  }

  return (
    toolExecutions.find(
      (item) => getSidebarToolCallId(item) === persisted.toolCallId,
    ) ?? null
  );
};
