/**
 * PTY output formatting for model- and UI-facing text.
 *
 * `cleanPtyForUI` feeds raw PTY bytes through a headless xterm so cursor /
 * erase CSI sequences produce the same visible text xterm.js would render
 * in the browser. Falls back to regex ANSI stripping in environments that
 * don't have `@xterm/headless` (test / jsdom).
 */

let TerminalCtor:
  | (new (opts: { cols: number; rows: number; scrollback: number }) => {
      write: (data: string) => void;
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
} catch {
  // Not available (test env, missing dep) — regex fallback below.
}

const FALLBACK_ANSI =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

export function cleanPtyForUI(text: string): string {
  if (TerminalCtor) {
    try {
      const term = new TerminalCtor({ cols: 120, rows: 500, scrollback: 5000 });
      term.write(text);
      const buf = term.buffer.active;
      const lines: string[] = [];
      let lastNonEmpty = -1;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        const str = line ? line.translateToString(true) : "";
        lines.push(str);
        if (str.trim()) lastNonEmpty = i;
      }
      term.dispose();
      return lines.slice(0, lastNonEmpty + 1).join("\n");
    } catch {
      // Fall through to regex fallback.
    }
  }
  return text
    .replace(FALLBACK_ANSI, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "");
}

/** Return last N lines of a PTY snapshot as raw bytes (for streaming context). */
export function lastNLinesBytes(bytes: Uint8Array, n: number): Uint8Array {
  const text = cleanPtyForUI(new TextDecoder().decode(bytes));
  const lines = text.split("\n");
  if (lines.length <= n) return new TextEncoder().encode(text);
  return new TextEncoder().encode(lines.slice(-n).join("\n"));
}

interface SnapshotSource {
  snapshot(session: { sessionId: string; chatId: string }): Uint8Array;
}

export function getSessionSnapshot(
  mgr: SnapshotSource,
  session: { sessionId: string; chatId: string },
): string {
  const bytes = mgr.snapshot(session);
  return cleanPtyForUI(new TextDecoder().decode(bytes));
}
