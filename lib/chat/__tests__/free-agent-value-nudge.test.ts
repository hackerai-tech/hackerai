import {
  getFreeAgentValueNudgeStorageKey,
  hasShownFreeAgentValueNudge,
  markFreeAgentValueNudgeShown,
} from "../free-agent-value-nudge";

describe("free Agent value nudge", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("marks a nudge as shown in memory and localStorage", () => {
    const shownChatIds = new Set<string>();
    const chatId = "chat-free-agent-value";

    expect(hasShownFreeAgentValueNudge(shownChatIds, chatId)).toBe(false);

    markFreeAgentValueNudgeShown(shownChatIds, chatId);

    expect(hasShownFreeAgentValueNudge(shownChatIds, chatId)).toBe(true);
    expect(
      window.localStorage.getItem(getFreeAgentValueNudgeStorageKey(chatId)),
    ).toBe("1");
  });

  it("uses localStorage to dedupe after a remount clears memory", () => {
    const chatId = "chat-free-agent-value";
    window.localStorage.setItem(getFreeAgentValueNudgeStorageKey(chatId), "1");

    expect(hasShownFreeAgentValueNudge(new Set<string>(), chatId)).toBe(true);
  });

  it("keeps in-memory dedupe when localStorage is unavailable", () => {
    const shownChatIds = new Set<string>();
    const chatId = "chat-free-agent-value";

    markFreeAgentValueNudgeShown(shownChatIds, chatId, undefined);

    expect(hasShownFreeAgentValueNudge(shownChatIds, chatId, undefined)).toBe(
      true,
    );
  });
});
