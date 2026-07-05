export const FREE_AGENT_VALUE_NUDGE_PART_TYPE =
  "data-free-agent-value-nudge" as const;

export const FREE_AGENT_VALUE_NUDGE_STORAGE_PREFIX =
  "free-agent-value-nudge:" as const;

export const getFreeAgentValueNudgeStorageKey = (chatId: string) =>
  `${FREE_AGENT_VALUE_NUDGE_STORAGE_PREFIX}${chatId}`;

const getBrowserStorage = () => {
  if (typeof window === "undefined") return undefined;
  return window.localStorage;
};

export const hasShownFreeAgentValueNudge = (
  shownChatIds: Set<string>,
  chatId: string,
  storage: Storage | undefined = getBrowserStorage(),
) => {
  if (shownChatIds.has(chatId)) return true;
  if (!storage) return false;
  try {
    return storage.getItem(getFreeAgentValueNudgeStorageKey(chatId)) === "1";
  } catch {
    return false;
  }
};

export const markFreeAgentValueNudgeShown = (
  shownChatIds: Set<string>,
  chatId: string,
  storage: Storage | undefined = getBrowserStorage(),
) => {
  shownChatIds.add(chatId);
  if (!storage) return;
  try {
    storage.setItem(getFreeAgentValueNudgeStorageKey(chatId), "1");
  } catch {
    // Losing localStorage only means the nudge can reappear after a reload.
  }
};

export const FREE_AGENT_VALUE_NUDGE_ANALYTICS = {
  surface: "free_agent_value_nudge",
  source: "free_agent_value_reached",
  reason: "post_success_agent_run",
  from_tier: "free",
  cta_text: "Upgrade for cloud Agent",
} as const;
