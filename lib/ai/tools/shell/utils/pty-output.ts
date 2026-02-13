/**
 * Utilities for cleaning raw PTY output.
 *
 * The e2b sandbox emits OSC 633 shell-integration sequences containing
 * metadata (machineid, hostname, bootid, pid, cwd, etc.). When these are
 * split across PTY data chunks the payload text leaks into the visible
 * output. These helpers remove that noise while **preserving ANSI escape
 * sequences** (colors, cursor, etc.) for Shiki ANSI rendering in the UI.
 */

/**
 * Strip sentinel markers and related shell noise from PTY / tmux output.
 */
const SENTINEL_LINE_RE = /^.*__DONE_[a-f0-9]+__\d*.*$/gm;
const ECHO_SENTINEL_RE = /^.*echo\s+__DONE_[a-f0-9]+__.*$/gm;
const ECHO_START_RE = /^.*echo\s+__START_[a-f0-9]+__.*$/gm;
const START_MARKER_RE = /^.*__START_[a-f0-9]+__.*$/gm;

export const stripSentinelNoise = (text: string): string => {
  let cleaned = text;
  cleaned = cleaned.replace(SENTINEL_LINE_RE, "");
  cleaned = cleaned.replace(ECHO_SENTINEL_RE, "");
  cleaned = cleaned.replace(ECHO_START_RE, "");
  cleaned = cleaned.replace(START_MARKER_RE, "");

  const lines = cleaned.split("\n");
  const filteredLines = lines.filter((line) => {
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!stripped || /^[^$#]*[#$]\s*$/.test(stripped)) return false;
    return true;
  });
  cleaned = filteredLines.join("\n");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned;
};
