/**
 * Utilities for cleaning raw PTY output.
 *
 * The e2b sandbox emits OSC 633 shell-integration sequences containing
 * metadata (machineid, hostname, bootid, pid, cwd, etc.). When these are
 * split across PTY data chunks the payload text leaks into the visible
 * output. These helpers remove that noise while **preserving ANSI escape
 * sequences** (colors, cursor, etc.) for Shiki ANSI rendering in the UI.
 */

// Pre-compiled regexes — avoids re-creation on every call.
// Each pattern requires the ESC (\x1b) prefix so we never accidentally match
// literal text that happens to contain `]3008;` or `[?2004`.

/** VS Code shell-integration: \x1b]633;…BEL or \x1b]633;…ST */
const OSC_633_RE = /\x1b\]633;[^\x07\x1b]*(?:\x07|\x1b\\)\r?\n?/g;

/** E2B sandbox metadata: \x1b]3008;…key=value;…\ (backslash-terminated) */
const OSC_3008_RE = /\x1b\]3008;[^\\\n]*\\\r?\n?/g;

/** Bracketed paste mode on/off: \x1b[?2004h / \x1b[?2004l */
const BRACKETED_PASTE_RE = /\x1b\[\?2004[hl]\r?\n?/g;

/** Orphaned leading \r?\n left after the above removals. */
const LEADING_CRLF_RE = /^(\r?\n)+/;

/**
 * Strip PTY/terminal noise while preserving ANSI color/style sequences.
 *
 * Only targets sequences that are PTY infrastructure noise (shell-integration,
 * sandbox metadata, bracketed paste). All ANSI SGR color/style, cursor, and
 * erase sequences pass through untouched.
 */
export const stripTerminalEscapes = (output: string): string => {
  // Fast path: nothing to strip if there is no ESC byte.
  if (output.indexOf("\x1b") === -1) return output;

  let result = output;
  result = result.replace(OSC_633_RE, "");
  result = result.replace(OSC_3008_RE, "");
  result = result.replace(BRACKETED_PASTE_RE, "");
  result = result.replace(LEADING_CRLF_RE, "");

  return result;
};

/**
 * Strip the echoed command from PTY output.
 *
 * When a command is sent to a PTY the terminal echoes it back before the
 * real output. This is noise for the AI model.
 */
export const stripCommandEcho = (output: string, command: string): string => {
  let result = output;

  // Strip leading echoed command (PTY echoes "command\n" before real output).
  // The echo may contain the full command or just part of it if line-wrapped.
  const commandLine = command.trim();
  const lines = result.split("\n");

  const echoIndex = lines.findIndex(
    (line) =>
      line.trim() === commandLine ||
      line.trim().endsWith(commandLine) ||
      commandLine.endsWith(line.trim()),
  );
  if (echoIndex !== -1 && echoIndex < 3) {
    lines.splice(echoIndex, 1);
  }

  result = lines.join("\n");

  return result.trim();
};

/**
 * Strip sentinel markers from PTY output.
 *
 * After an `exec` times out, the command keeps running. When it finishes the
 * sentinel line (`__DONE_<hex>__<exitcode>`) appears in the buffer.
 * Subsequent `view` / `wait` calls should not expose these internals.
 */
const SENTINEL_LINE_RE = /^.*__DONE_[a-f0-9]+__\d*.*$/gm;
export const stripSentinelNoise = (text: string): string => {
  let cleaned = text.replace(SENTINEL_LINE_RE, "");
  // Collapse multiple blank lines left by the removal
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
};
