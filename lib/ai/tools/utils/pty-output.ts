/**
 * Utilities for cleaning raw PTY output.
 *
 * The e2b sandbox emits OSC 633 shell-integration sequences containing
 * metadata (machineid, hostname, bootid, pid, cwd, etc.). When these are
 * split across PTY data chunks the payload text leaks into the visible
 * output. These helpers remove that noise while **preserving ANSI escape
 * sequences** (colors, cursor, etc.) for Shiki ANSI rendering in the UI.
 */

// ---------------------------------------------------------------------------
// Sequence-level regex — strips properly-terminated OSC sequences without
// destroying real output text that may follow on the same line.
// OSC = ESC ] ... terminated by BEL (\x07), ST (\x1b\\), or C1 ST (\x9c).
// ---------------------------------------------------------------------------
const OSC_COMPLETE_RE = /\x1b\][^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)/g;

// ---------------------------------------------------------------------------
// Line-level regexes — fallback for unterminated / split-across-chunks OSC
// sequences where the terminator never arrived in this buffer.
// Uses multiline flag so ^/$ match line boundaries. Removes the whole line
// including its trailing newline.
// ---------------------------------------------------------------------------

/** VS Code shell-integration: any line containing ]633; */
const OSC_633_RE = /^.*\]633;.*$\r?\n?/gm;

/** E2B sandbox metadata: any line containing ]3008; */
const OSC_3008_RE = /^.*\]3008;.*$\r?\n?/gm;

/** Bracketed paste mode: any line containing [?2004h or [?2004l */
const BRACKETED_PASTE_RE = /^.*\[\?2004[hl].*$\r?\n?/gm;

/** Orphaned leading \r?\n left after the above removals. */
const LEADING_CRLF_RE = /^(\r?\n)+/;

/**
 * Strip PTY/terminal noise while preserving ANSI color/style sequences.
 *
 * Only targets sequences that are PTY infrastructure noise (shell-integration,
 * sandbox metadata, bracketed paste). All ANSI SGR color/style, cursor, and
 * erase sequences pass through untouched.
 *
 * Two-pass approach:
 * 1. Strip complete (properly terminated) OSC sequences at the sequence level.
 *    This prevents the line-level fallback from accidentally nuking real output
 *    that follows an OSC marker on the same line in the accumulated buffer.
 * 2. Strip entire lines that still contain unterminated OSC markers (split
 *    across PTY data chunks, missing their terminator).
 */
export const stripTerminalEscapes = (output: string): string => {
  // Fast path: nothing to strip if there is no ESC byte.
  if (output.indexOf("\x1b") === -1) return output;

  let result = output;
  // Pass 1: strip complete OSC sequences (sequence-level, preserves surrounding text)
  result = result.replace(OSC_COMPLETE_RE, "");
  // Pass 2: strip lines with remaining unterminated OSC markers
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
  return cleaned;
};
