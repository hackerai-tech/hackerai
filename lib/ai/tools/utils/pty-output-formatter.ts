/**
 * PTY output formatting for model- and UI-facing text.
 *
 * `cleanPtyForUI` feeds raw PTY bytes through a headless xterm so cursor /
 * erase CSI sequences produce the same visible text xterm.js would render
 * in the browser. Falls back to regex ANSI stripping in environments that
 * don't have `@xterm/headless` (test / jsdom).
 */

import { DEFAULT_PTY_COLS } from "./pty-session-manager";

// The headless parser needs to see the SAME column count as the runtime PTY
// so ANSI line-wrapping/cursor math lines up. Rows + scrollback are
// intentionally much larger than runtime geometry — they're sizing the
// in-memory scrollback replay, not the live terminal.
const PARSER_ROWS = 500;
const PARSER_SCROLLBACK = 5000;

let TerminalCtor:
  | (new (opts: {
      cols: number;
      rows: number;
      scrollback: number;
      allowProposedApi?: boolean;
    }) => {
      write: (data: string, callback?: () => void) => void;
      buffer: {
        active: {
          length: number;
          getLine: (
            i: number,
          ) =>
            | { translateToString: (trimRight: boolean) => string }
            | undefined;
        };
      };
      dispose: () => void;
    })
  | null = null;

try {
  TerminalCtor = require("@xterm/headless").Terminal;
} catch (err) {
  console.warn(
    "[pty-output-formatter] xterm/headless not available, using regex fallback:",
    err,
  );
}

// Comprehensive ANSI/VT100 escape sequence patterns
const ANSI_PATTERNS = [
  /\x1B\[[0-9;]*[A-Za-z]/g, // CSI sequences: cursor, colors, clear
  /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, // OSC sequences
  /\x1B[PX^_][^\x1B]*\x1B\\/g, // DCS, SOS, PM, APC
  /\x1B[@-Z\\-_]/g, // Single-char escapes (Fe)
  /\x1B\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g, // Full CSI
  /\x9B[0-9;]*[A-Za-z]/g, // 8-bit CSI (C1)
];

function fallbackClean(text: string): string {
  let result = text;
  for (const pattern of ANSI_PATTERNS) {
    result = result.replace(pattern, "");
  }
  return result
    .replace(/\r\n/g, "\n")
    .replace(/\r(?!\n)/g, "") // CR without LF (overwrite mode)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ""); // Other control chars
}

export async function cleanPtyForUI(text: string): Promise<string> {
  if (TerminalCtor) {
    const term = new TerminalCtor({
      cols: DEFAULT_PTY_COLS,
      rows: PARSER_ROWS,
      scrollback: PARSER_SCROLLBACK,
      allowProposedApi: true,
    });
    try {
      // `@xterm/headless` Terminal.write is asynchronous — it enqueues into a
      // WriteBuffer and processes on a later tick. Without the callback, the
      // buffer we read below is still empty. Await parsing completion before
      // snapshotting buffer.active.
      await new Promise<void>((resolve) => term.write(text, resolve));
      const buf = term.buffer.active;
      const lines: string[] = [];
      let lastNonEmpty = -1;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        const str = line ? line.translateToString(true) : "";
        lines.push(str);
        if (str.trim()) lastNonEmpty = i;
      }
      return lines.slice(0, lastNonEmpty + 1).join("\n");
    } catch (err) {
      console.warn(
        "[pty-output-formatter] xterm parsing failed, using fallback:",
        err,
      );
    } finally {
      term.dispose();
    }
  }
  return fallbackClean(text);
}

/** Return last N lines of a PTY snapshot as raw bytes (for streaming context). */
export async function lastNLinesBytes(
  bytes: Uint8Array,
  n: number,
): Promise<Uint8Array> {
  const text = await cleanPtyForUI(new TextDecoder().decode(bytes));
  const lines = text.split("\n");
  if (lines.length <= n) return new TextEncoder().encode(text);
  return new TextEncoder().encode(lines.slice(-n).join("\n"));
}

interface SnapshotSource {
  snapshot(session: { sessionId: string; chatId: string }): Uint8Array;
}

export async function getSessionSnapshot(
  mgr: SnapshotSource,
  session: { sessionId: string; chatId: string },
): Promise<string> {
  const bytes = mgr.snapshot(session);
  return cleanPtyForUI(new TextDecoder().decode(bytes));
}

/** Returns both raw and cleaned snapshots for persistence. */
export async function getSessionSnapshots(
  mgr: SnapshotSource,
  session: { sessionId: string; chatId: string },
): Promise<{ raw: string; cleaned: string }> {
  const bytes = mgr.snapshot(session);
  const raw = new TextDecoder().decode(bytes);
  const cleaned = await cleanPtyForUI(raw);
  return { raw, cleaned };
}
