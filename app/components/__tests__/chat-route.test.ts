import { finalizeNewChatRoute } from "../chat-route";

describe("finalizeNewChatRoute", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("does not redirect a new task when the previous stream aborts", () => {
    window.history.replaceState({}, "", "/c/previous-chat");

    expect(
      finalizeNewChatRoute({
        chatId: "replacement-chat",
        isAbort: true,
        isExistingChat: false,
        isTemporaryChat: false,
      }),
    ).toBe(false);

    expect(window.location.pathname).toBe("/c/previous-chat");

    // The pending Next.js New task navigation remains authoritative.
    window.history.pushState({}, "", "/");
    expect(window.location.pathname).toBe("/");
  });

  it("still finalizes a manually stopped chat that owns the current route", () => {
    window.history.replaceState({}, "", "/c/current-chat");

    expect(
      finalizeNewChatRoute({
        chatId: "current-chat",
        isAbort: true,
        isExistingChat: false,
        isTemporaryChat: false,
      }),
    ).toBe(true);

    expect(window.location.pathname).toBe("/c/current-chat");
  });

  it("finalizes a normally completed new chat", () => {
    expect(
      finalizeNewChatRoute({
        chatId: "completed-chat",
        isAbort: false,
        isExistingChat: false,
        isTemporaryChat: false,
      }),
    ).toBe(true);

    expect(window.location.pathname).toBe("/c/completed-chat");
  });
});
