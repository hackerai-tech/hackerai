import { normalizeBrowserInput, normalizeBrowserInputBatch } from "../input";

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
        text: "",
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
        text: "",
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

it.each([
  ["Enter", "Enter", 13],
  ["Tab", "Tab", 9],
  ["Backspace", "Backspace", 8],
  ["Delete", "Delete", 46],
  ["ArrowLeft", "ArrowLeft", 37],
  ["a", "KeyA", 65],
])(
  "sends the native key code for %s editing actions",
  (key, code, virtualKey) => {
    const events = normalizeBrowserInput({
      kind: "key",
      key,
      code,
      modifiers: key === "a" ? 2 : 0,
    })!;
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      eventType: key === "Enter" ? "keyDown" : "rawKeyDown",
      text: key === "Enter" ? "\r" : "",
      key,
      code,
      windowsVirtualKeyCode: virtualKey,
    });
    expect(events[1]).toMatchObject({
      eventType: "keyUp",
      text: "",
      key,
      code,
      windowsVirtualKeyCode: virtualKey,
    });
    if (key === "Enter") expect(events[0].text).toBe("\r");
  },
);

it("translates pasted line breaks into Enter input", () => {
  const events = normalizeBrowserInput({ kind: "text", text: "a\nb" })!;
  expect(events.slice(2, 4)).toMatchObject([
    {
      eventType: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      text: "\r",
    },
    {
      eventType: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    },
  ]);
});

it("validates an entire ordered input batch before dispatch", () => {
  const inputs = [
    { kind: "down", x: 10, y: 20 },
    { kind: "up", x: 10, y: 20 },
    { kind: "text", text: "A.b@C-d!" },
  ];
  expect(normalizeBrowserInputBatch(inputs)).toEqual(
    inputs.flatMap((input) => normalizeBrowserInput(input)!),
  );
  expect(
    normalizeBrowserInputBatch([
      ...inputs,
      { type: "cdp", method: "Network.getAllCookies" },
    ]),
  ).toBeNull();
  expect(normalizeBrowserInputBatch([])).toBeNull();
  expect(
    normalizeBrowserInputBatch(Array(17).fill({ kind: "down", x: 1, y: 1 })),
  ).toBeNull();
  expect(
    normalizeBrowserInputBatch([
      { kind: "text", text: "a".repeat(32) },
      { kind: "key", key: "Enter", code: "Enter" },
    ]),
  ).toBeNull();
});

it("keeps a maximum editing batch within the bridge stdin limit", () => {
  const events = normalizeBrowserInputBatch(
    Array(16).fill({ kind: "key", key: "Enter", code: "Enter" }),
  )!;
  expect(events).not.toBeNull();
  expect(JSON.stringify(events).length).toBeLessThanOrEqual(8192);
});
