type Input =
  | { kind: "click" | "move" | "down" | "up"; x: number; y: number }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "key"; key: string; code: string; modifiers?: number }
  | { kind: "text"; text: string };

const punctuationCodes: Record<string, string> = {
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "`": "Backquote",
};
const shiftedCodes: Record<string, string> = {
  "!": "Digit1",
  "@": "Digit2",
  "#": "Digit3",
  $: "Digit4",
  "%": "Digit5",
  "^": "Digit6",
  "&": "Digit7",
  "*": "Digit8",
  "(": "Digit9",
  ")": "Digit0",
  _: "Minus",
  "+": "Equal",
  "{": "BracketLeft",
  "}": "BracketRight",
  "|": "Backslash",
  ":": "Semicolon",
  '"': "Quote",
  "<": "Comma",
  ">": "Period",
  "?": "Slash",
  "~": "Backquote",
};

// CDP requires native virtual key codes for editing/navigation defaults.
const editingKeyCodes: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
};

const virtualKeyCode = (code: string) =>
  editingKeyCodes[code] ??
  (/^Key[A-Z]$/.test(code)
    ? code.charCodeAt(3)
    : /^Digit[0-9]$/.test(code)
      ? code.charCodeAt(5)
      : 0);

const coordinate = (value: unknown) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 8192;
const delta = (value: unknown) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  Math.abs(value) <= 2000;

/** Accept only viewport input. No arbitrary CDP or browser commands. */
export function normalizeBrowserInput(
  value: unknown,
): Record<string, unknown>[] | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<Input> & Record<string, unknown>;
  if (["click", "move", "down", "up"].includes(String(input.kind))) {
    if (!coordinate(input.x) || !coordinate(input.y)) return null;
    const x = Math.round(input.x as number);
    const y = Math.round(input.y as number);
    if (input.kind === "move") {
      return [{ type: "input_mouse", eventType: "mouseMoved", x, y }];
    }
    if (input.kind === "down" || input.kind === "up") {
      return [
        {
          type: "input_mouse",
          eventType: input.kind === "down" ? "mousePressed" : "mouseReleased",
          x,
          y,
          button: "left",
          ...(input.kind === "down" ? { clickCount: 1 } : {}),
        },
      ];
    }
    return [
      {
        type: "input_mouse",
        eventType: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      },
      { type: "input_mouse", eventType: "mouseReleased", x, y, button: "left" },
    ];
  }
  if (input.kind === "wheel") {
    if (
      !coordinate(input.x) ||
      !coordinate(input.y) ||
      !delta(input.deltaX) ||
      !delta(input.deltaY)
    )
      return null;
    return [
      {
        type: "input_mouse",
        eventType: "mouseWheel",
        x: Math.round(input.x as number),
        y: Math.round(input.y as number),
        deltaX: input.deltaX,
        deltaY: input.deltaY,
      },
    ];
  }
  if (input.kind === "key") {
    if (
      typeof input.key !== "string" ||
      input.key.length > 32 ||
      typeof input.code !== "string" ||
      input.code.length > 40 ||
      !Number.isInteger(input.modifiers ?? 0) ||
      (input.modifiers ?? 0) < 0 ||
      (input.modifiers ?? 0) > 15
    )
      return null;
    const event = {
      type: "input_keyboard",
      key: input.key,
      code: input.code,
      modifiers: input.modifiers ?? 0,
      windowsVirtualKeyCode: virtualKeyCode(input.code),
    };
    return [
      {
        ...event,
        eventType: "keyDown",
        ...(input.key === "Enter" ? { text: "\r" } : {}),
      },
      { ...event, eventType: "keyUp" },
    ];
  }
  if (input.kind === "text") {
    if (
      typeof input.text !== "string" ||
      input.text.length < 1 ||
      input.text.length > 64
    )
      return null;
    const chars = [...input.text];
    if (chars.length > 32) return null;
    // The pinned stream needs a physical code and a balanced key pair. Bare
    // char events and keyDown without code are accepted but do not edit input.
    return chars.flatMap((text) => {
      if (text === "\n" || text === "\r") {
        return normalizeBrowserInput({
          kind: "key",
          key: "Enter",
          code: "Enter",
        })!;
      }
      const code = /^[a-z]$/i.test(text)
        ? `Key${text.toUpperCase()}`
        : /^[0-9]$/.test(text)
          ? `Digit${text}`
          : text === " "
            ? "Space"
            : (punctuationCodes[text] ?? shiftedCodes[text] ?? "Unidentified");
      const modifiers = /^[A-Z]$/.test(text) || shiftedCodes[text] ? 8 : 0;
      return [
        {
          type: "input_keyboard",
          eventType: "keyDown",
          key: text,
          code,
          modifiers,
          text,
        },
        {
          type: "input_keyboard",
          eventType: "keyUp",
          key: text,
          code,
          modifiers,
        },
      ];
    });
  }
  return null;
}

/** Bound both user actions and expanded wire events for one ordered batch. */
export function normalizeBrowserInputBatch(inputs: unknown) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 32)
    return null;
  const events: Record<string, unknown>[] = [];
  for (const input of inputs) {
    const normalized = normalizeBrowserInput(input);
    if (!normalized || events.length + normalized.length > 64) return null;
    events.push(...normalized);
  }
  return events;
}
