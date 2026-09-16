import { shutdownIntercomSession } from "../client";

describe("shutdownIntercomSession", () => {
  it("shuts down Messenger and removes Intercom cookies", () => {
    const shutdown = jest.fn();
    Object.defineProperty(window, "Intercom", {
      configurable: true,
      value: shutdown,
    });
    document.cookie = "intercom-session-wjc8uwt3=session; path=/";
    document.cookie = "unrelated=value; path=/";

    shutdownIntercomSession();

    expect(shutdown).toHaveBeenCalledWith("shutdown");
    expect(document.cookie).not.toContain("intercom-session-wjc8uwt3");
    expect(document.cookie).toContain("unrelated=value");
  });
});
