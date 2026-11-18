import {
  finalizeNewChatRoute,
  getRouteChatIdFromPathname,
} from "../chat-route";

describe("getRouteChatIdFromPathname", () => {
  it.each([
    ["/c/chat-a", "chat-a"],
    ["/c/chat%20a/share", "chat a"],
    ["/c/%E0%A4%A", "%E0%A4%A"],
    ["/", null],
    ["/c/", null],
    ["/findings", null],
    [null, null],
  ])("reads %p as %p", (pathname, expected) => {
    expect(getRouteChatIdFromPathname(pathname)).toBe(expected);
  });
});

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
      }),
    ).toBe(true);

    expect(window.location.pathname).toBe("/c/current-chat");
  });

  it("keeps a failed admission on the draft route when the SDK calls onFinish after onError", () => {
    expect(
      finalizeNewChatRoute({
        chatId: "unsaved-task",
        isAbort: false,
        isError: true,
        isExistingChat: false,
      }),
    ).toBe(false);
    expect(window.location.pathname).toBe("/");
  });

  it("finalizes a normally completed new chat", () => {
    expect(
      finalizeNewChatRoute({
        chatId: "completed-chat",
        isAbort: false,
        isExistingChat: false,
      }),
    ).toBe(true);

    expect(window.location.pathname).toBe("/c/completed-chat");
  });

  it("does not let a stale normal completion replace another chat route", () => {
    window.history.replaceState({}, "", "/c/destination-chat");

    expect(
      finalizeNewChatRoute({
        chatId: "stale-chat",
        isAbort: false,
        isExistingChat: false,
      }),
    ).toBe(false);

    expect(window.location.pathname).toBe("/c/destination-chat");
  });
});
