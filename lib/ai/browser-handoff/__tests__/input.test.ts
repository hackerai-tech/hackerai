import { normalizeBrowserInput } from "../input";

describe("browser input boundary", () => {
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
        text: "h",
      },
      { type: "input_keyboard", eventType: "keyUp", key: "h", code: "KeyH" },
      {
        type: "input_keyboard",
        eventType: "keyDown",
        key: "i",
        code: "KeyI",
        text: "i",
      },
      { type: "input_keyboard", eventType: "keyUp", key: "i", code: "KeyI" },
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
