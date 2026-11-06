// Keep the help panel, tooltips, and handlers on the same bindings.
export const SHORTCUTS = {
  shortcuts: { label: "Keyboard shortcuts", key: "/", mod: true },
  newTask: { label: "New task", key: "o", mod: true, shift: true },
  search: { label: "Search tasks", key: "k", mod: true },
  sidebar: { label: "Toggle sidebar", key: "s", mod: true, shift: true },
  send: { label: "Send message", key: "Enter" },
  newline: { label: "Insert new line", key: "Enter", shift: true },
  stop: { label: "Stop response", key: "x", mod: true, shift: true },
} as const;

export type ShortcutId = keyof typeof SHORTCUTS;
type Binding = { key: string; mod?: boolean; shift?: boolean };

export function shortcutKeys(id: ShortcutId, isMac: boolean): string[] {
  const binding: Binding = SHORTCUTS[id];
  return [
    ...(binding.mod ? [isMac ? "⌘" : "Ctrl"] : []),
    ...(binding.shift ? [isMac ? "⇧" : "Shift"] : []),
    binding.key === "Enter" ? "Enter" : binding.key.toUpperCase(),
  ];
}

export function isMacPlatform(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)
  );
}

export function formatShortcut(id: ShortcutId, isMac: boolean): string {
  return shortcutKeys(id, isMac).join(isMac ? "" : "+");
}

export function spokenShortcutKey(key: string): string {
  const names: Record<string, string> = {
    "⌘": "Command",
    "⇧": "Shift",
    Ctrl: "Control",
    "/": "Slash",
  };
  return names[key] ?? key;
}

export function matchesShortcut(
  event: KeyboardEvent,
  id: ShortcutId,
  isMac = isMacPlatform(),
): boolean {
  const binding: Binding = SHORTCUTS[id];
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.repeat ||
    event.altKey ||
    (event.ctrlKey && event.metaKey) ||
    (binding.mod
      ? isMac
        ? !event.metaKey || event.ctrlKey
        : !event.ctrlKey || event.metaKey
      : event.metaKey || event.ctrlKey) ||
    typeof event.key !== "string"
  )
    return false;

  // Some layouts need Shift to type a literal slash.
  if (id === "shortcuts" && event.key === "/") return true;
  if (event.shiftKey !== Boolean(binding.shift)) return false;
  const key = event.key;
  if (key.toLowerCase() === binding.key.toLowerCase()) return true;
  const nonAsciiCharacter = key.length === 1 && /[^\x00-\x7f]/.test(key);
  if (id === "shortcuts") return nonAsciiCharacter && event.code === "Slash";
  // Keep letter bindings usable with non-Latin layouts, without confusing
  // remapped Latin keys (e.g. Dvorak) with their physical positions.
  return (
    /^[a-z]$/i.test(binding.key) &&
    nonAsciiCharacter &&
    event.code === `Key${binding.key.toUpperCase()}`
  );
}

export function isShortcutTargetBlocked(event: KeyboardEvent): boolean {
  const target = event.target;
  // These surfaces own their keystrokes, including copy, terminal interrupts,
  // and editor shortcuts. Iframes naturally keep their events in their document.
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        '.xterm, .monaco-editor, [data-keyboard-shortcuts="ignore"]',
      ),
    )
  );
}

export function hasOpenShortcutOverlay(): boolean {
  return Boolean(
    document.querySelector(
      '[role="dialog"]:not([data-shortcuts-scope="navigation"]), [role="alertdialog"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
    ),
  );
}

export const OPEN_SHORTCUTS_EVENT = "open-keyboard-shortcuts";

export function openKeyboardShortcuts(): void {
  window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT));
}
