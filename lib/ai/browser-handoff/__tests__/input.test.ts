import { normalizeBrowserInput } from "../input";

describe("browser input boundary", () => {
  it("preserves physical keys and Shift for email punctuation and uppercase text", () => {
    const events = normalizeBrowserInput({ kind: "text", text: "a.b@c-d!AZ" })!;
    expect(
      events
        .filter((event) => event.eventType === "keyDown")
        .map((event) => [event.key, event.code, event.modifiers ?? 0]),
    ).toEqual([
      ["a", "KeyA", 0],
      [".", "Period", 0],
      ["b", "KeyB", 0],
      ["@", "Digit2", 8],
      ["c", "KeyC", 0],
      ["-", "Minus", 0],
      ["d", "KeyD", 0],
      ["!", "Digit1", 8],
      ["A", "KeyA", 8],
      ["Z", "KeyZ", 8],
    ]);
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i + 1]).toMatchObject({
        eventType: "keyUp",
        key: events[i].key,
        code: events[i].code,
        modifiers: events[i].modifiers,
      });
    }
  });
  it("accepts bounded viewport controls and preserves text only in input payloads", () => {
    expect(normalizeBrowserInput({ kind: "click", x: 120.4, y: 43.8 })).toEqual(
      [
        {
          type: "input_mouse",
          eventType: "mousePressed",
          x: 120,
          y: 44,
          button: "left",
          clickCount: 1,
        },
        {
          type: "input_mouse",
          eventType: "mouseReleased",
          x: 120,
          y: 44,
          button: "left",
        },
      ],
    );
    expect(normalizeBrowserInput({ kind: "text", text: "hi" })).toEqual([
      {
        type: "input_keyboard",
        eventType: "keyDown",
        key: "h",
        code: "KeyH",
        modifiers: 0,
        text: "h",
      },
      {
        type: "input_keyboard",
        eventType: "keyUp",
        key: "h",
        code: "KeyH",
        modifiers: 0,
      },
      {
        type: "input_keyboard",
        eventType: "keyDown",
        key: "i",
        code: "KeyI",
        modifiers: 0,
        text: "i",
      },
      {
        type: "input_keyboard",
        eventType: "keyUp",
        key: "i",
        code: "KeyI",
        modifiers: 0,
      },
    ]);
  });

  it("rejects commands, offscreen coordinates, and oversized text", () => {
    expect(
      normalizeBrowserInput({ type: "cdp", method: "Network.getAllCookies" }),
    ).toBeNull();
    expect(normalizeBrowserInput({ kind: "click", x: -1, y: 2 })).toBeNull();
    expect(
      normalizeBrowserInput({
        kind: "wheel",
        x: 1,
        y: 1,
        deltaY: Infinity,
        deltaX: 0,
      }),
    ).toBeNull();
    expect(
      normalizeBrowserInput({ kind: "text", text: "x".repeat(65) }),
    ).toBeNull();
  });
});
