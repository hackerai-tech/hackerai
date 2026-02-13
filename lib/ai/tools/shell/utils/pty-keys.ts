/**
 * Tmux-style special key name mappings and input translation for PTY sessions.
 */

export const SPECIAL_KEYS: Record<string, string> = {
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
  Enter: "\r",
  Tab: "\t",
  Escape: "\x1b",
  Space: " ",
  BSpace: "\x7f",
  Up: "\x1b[A",
  Down: "\x1b[B",
  Right: "\x1b[C",
  Left: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  DC: "\x1b[3~",
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

export const TMUX_SPECIAL_KEYS: ReadonlySet<string> = new Set(
  Object.keys(SPECIAL_KEYS),
);

export const RAW_TO_KEY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(SPECIAL_KEYS).map(([name, raw]) => [raw, name]),
);

export const translateInput = (input: string): Uint8Array => {
  const encoder = new TextEncoder();
  if (SPECIAL_KEYS[input]) return encoder.encode(SPECIAL_KEYS[input]);
  if (input.startsWith("M-") && input.length === 3) {
    return encoder.encode(`\x1b${input[2]}`);
  }
  if (input.startsWith("C-S-") && input.length === 5) {
    const ch = input[4].toUpperCase();
    const code = ch.charCodeAt(0) - 64;
    if (code >= 0 && code <= 31) {
      return encoder.encode(String.fromCharCode(code));
    }
  }
  return encoder.encode(input);
};
