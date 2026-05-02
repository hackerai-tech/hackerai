/**
 * Tmux-style special key name mappings and input translation for PTY sessions.
 */

/**
 * Canonical mapping of tmux key names → raw escape sequences / characters.
 *
 * Shared across:
 *  - E2B PTY sessions  (translateInput)
 *  - Local tmux sessions (TMUX_SPECIAL_KEYS set)
 *  - UI display         (reverse lookup for formatSendInput)
 */
export const SPECIAL_KEYS: Record<string, string> = {
  // Ctrl combinations
  "C-c": "\x03",
  "C-d": "\x04",
  "C-z": "\x1a",
  "C-a": "\x01",
  "C-b": "\x02",
  "C-e": "\x05",
  "C-f": "\x06",
  "C-g": "\x07",
  "C-h": "\x08",
  "C-i": "\x09",
  "C-j": "\x0a",
  "C-k": "\x0b",
  "C-l": "\x0c",
  "C-n": "\x0e",
  "C-o": "\x0f",
  "C-p": "\x10",
  "C-q": "\x11",
  "C-r": "\x12",
  "C-s": "\x13",
  "C-t": "\x14",
  "C-u": "\x15",
  "C-v": "\x16",
  "C-w": "\x17",
  "C-x": "\x18",
  "C-y": "\x19",
  // Named keys — aliases come FIRST so the canonical name wins the reverse
  // lookup in RAW_TO_KEY_NAME (last-one-wins; see comment on that map).
  Return: "\r", // alias
  Enter: "\r", // canonical
  Tab: "\t",
  Esc: "\x1b", // alias (also what the tool describe advertises)
  Escape: "\x1b", // canonical
  Space: " ",
  Backspace: "\x7f", // alias
  BSpace: "\x7f", // canonical (tmux name)
  // Arrow keys
  Up: "\x1b[A",
  Down: "\x1b[B",
  Right: "\x1b[C",
  Left: "\x1b[D",
  // Navigation
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  DC: "\x1b[3~", // Delete key (tmux name)
  // Function keys
  F1: "\x1bOP",
  F2: "\x1bOQ",
  F3: "\x1bOR",
  F4: "\x1bOS",
  F5: "\x1b[15~",
  F6: "\x1b[17~",
  F7: "\x1b[18~",
  F8: "\x1b[19~",
  F9: "\x1b[20~",
  F10: "\x1b[21~",
  F11: "\x1b[23~",
  F12: "\x1b[24~",
};

/** Set of all known tmux special key names (derived from SPECIAL_KEYS). */
export const TMUX_SPECIAL_KEYS: ReadonlySet<string> = new Set(
  Object.keys(SPECIAL_KEYS),
);

/**
 * Reverse lookup: raw character/escape sequence → tmux key name.
 * Built from SPECIAL_KEYS so it stays in sync automatically.
 * When multiple names map to the same raw value, the last one wins —
 * order in SPECIAL_KEYS is intentional (e.g. BSpace over C-h for \x08).
 */
export const RAW_TO_KEY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(SPECIAL_KEYS).map(([name, raw]) => [raw, name]),
);

/**
 * Translate tmux-style key names to escape sequences.
 * If the input matches a known key name, return the escape sequence.
 * Otherwise, return the raw string as-is, with one ergonomic tweak: a
 * trailing real newline (LF, CR, or CRLF) is canonicalized to `\r` so
 * `"hackerai-test-project\n"` in a single call submits the line the
 * same way a `"Enter"` follow-up would.
 */
export const translateInput = (input: string): Uint8Array => {
  const encoder = new TextEncoder();

  if (SPECIAL_KEYS[input]) {
    return encoder.encode(SPECIAL_KEYS[input]);
  }

  // M- (Alt) prefix: e.g. M-x -> ESC x
  if (input.startsWith("M-") && input.length === 3) {
    return encoder.encode(`\x1b${input[2]}`);
  }

  // C-S- (Ctrl+Shift) prefix: e.g. C-S-A
  if (input.startsWith("C-S-") && input.length === 5) {
    const ch = input[4].toUpperCase();
    const code = ch.charCodeAt(0) - 64;
    if (code >= 0 && code <= 31) {
      return encoder.encode(String.fromCharCode(code));
    }
  }

  // Raw string — normalize trailing newline(s) to \r so a single send of
  // "my answer\n" submits the line. Only ONE trailing newline sequence is
  // replaced; embedded newlines (e.g. pasting a multi-line block) pass
  // through unchanged.
  if (input.endsWith("\r\n")) {
    return encoder.encode(input.slice(0, -2) + "\r");
  }
  if (input.endsWith("\n") || input.endsWith("\r")) {
    return encoder.encode(input.slice(0, -1) + "\r");
  }

  return encoder.encode(input);
};

/**
 * Translate a sequence of tokens (each either a key name or literal text)
 * and concatenate their byte sequences in order. Enables callers to mix
 * typing text with submitting via Enter/Tab/arrows in a single call:
 *   translateInputSequence(["hackerai-test-project", "Enter"])
 * becomes the bytes "hackerai-test-project\r".
 */
export const translateInputSequence = (tokens: string[]): Uint8Array => {
  const parts = tokens.map((t) => translateInput(t));
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
};
