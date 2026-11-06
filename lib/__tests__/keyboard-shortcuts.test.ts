import { matchesShortcut, shortcutKeys } from "../keyboard-shortcuts";

describe("web keyboard bindings", () => {
  it("uses Command on Mac and leaves Mac Control+K editing alone", () => {
    expect(
      matchesShortcut(
        new KeyboardEvent("keydown", { key: "k", metaKey: true }),
        "search",
        true,
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        new KeyboardEvent("keydown", { key: "k", ctrlKey: true }),
        "search",
        true,
      ),
    ).toBe(false);
    expect(
      matchesShortcut(
        new KeyboardEvent("keydown", { key: "k", ctrlKey: true }),
        "search",
        false,
      ),
    ).toBe(true);
  });

  it.each([
    { key: "k", ctrlKey: true, altKey: true },
    { key: "k", ctrlKey: true, shiftKey: true },
    { key: "k", ctrlKey: true, metaKey: true },
    { key: "k", ctrlKey: true, repeat: true },
    { key: "k", ctrlKey: true, isComposing: true },
    { key: "k", ctrlKey: true, keyCode: 229 },
  ])("does not consume modified, repeating, or composing input: %j", (init) => {
    expect(
      matchesShortcut(new KeyboardEvent("keydown", init), "search", false),
    ).toBe(false);
  });

  it("supports Caps Lock and non-Latin layouts without breaking remapped Latin keys", () => {
    expect(
      matchesShortcut(
        new KeyboardEvent("keydown", { key: "K", ctrlKey: true }),
        "search",
        false,
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        new KeyboardEvent("keydown", { key: "л", code: "KeyK", ctrlKey: true }),
        "search",
        false,
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        new KeyboardEvent("keydown", { key: "e", code: "KeyK", ctrlKey: true }),
        "search",
        false,
      ),
    ).toBe(false);
  });

  it("opens help on layouts where slash needs Shift", () => {
    expect(
      matchesShortcut(
        new KeyboardEvent("keydown", {
          key: "/",
          ctrlKey: true,
          shiftKey: true,
        }),
        "shortcuts",
        false,
      ),
    ).toBe(true);
  });

  it("does not confuse remapped keys with Help or Stop", () => {
    const slash = new KeyboardEvent("keydown", {
      key: "/",
      code: "KeyX",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(matchesShortcut(slash, "shortcuts", false)).toBe(true);
    expect(matchesShortcut(slash, "stop", false)).toBe(false);
    expect(
      matchesShortcut(
        new KeyboardEvent("keydown", {
          key: "z",
          code: "Slash",
          ctrlKey: true,
        }),
        "shortcuts",
        false,
      ),
    ).toBe(false);
    expect(
      matchesShortcut(
        new KeyboardEvent("keydown", {
          key: "ж",
          code: "Slash",
          ctrlKey: true,
        }),
        "shortcuts",
        false,
      ),
    ).toBe(true);
  });

  it("matches Escape for Stop and keeps copy untouched", () => {
    expect(
      matchesShortcut(
        new KeyboardEvent("keydown", {
          key: "Escape",
        }),
        "stop",
        false,
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        new KeyboardEvent("keydown", { key: "c", ctrlKey: true }),
        "stop",
        false,
      ),
    ).toBe(false);
  });

  it("ignores events already handled by another surface", () => {
    const event = new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      cancelable: true,
    });
    event.preventDefault();
    expect(matchesShortcut(event, "search", false)).toBe(false);
  });

  it("shows platform-appropriate key names", () => {
    expect(shortcutKeys("newTask", true)).toEqual(["⌘", "⇧", "O"]);
    expect(shortcutKeys("stop", false)).toEqual(["Esc"]);
  });
});
