/**
 * Output cleaning utilities for tmux session captures.
 *
 * Extracts content between start/sentinel markers and strips shell
 * infrastructure noise (echo commands, bare prompts).
 */

/**
 * Normalize raw tmux capture-pane output for consistent delta calculations.
 */
export function normalizePaneCapture(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
}

/** Escape special regex characters in a string for use in RegExp. */
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove duplicate command lines. When pasting into tmux, the command can appear
 * multiple times (e.g. "$ command", "command", "user host % command"). Keep only
 * the canonical line with the full prompt (e.g. "user host % command").
 */
function deduplicateCommandLines(lines: string[], command: string): string[] {
  const trimmedCmd = command.trim();
  if (!trimmedCmd) return lines;

  const escaped = escapeForRegex(trimmedCmd);
  const bareRe = new RegExp(`^\\s*${escaped}\\s*$`);
  const prefixRe = new RegExp(`^\\s*[$#]\\s*${escaped}\\s*$`);

  const hasCanonicalLine = lines.some((line) => {
    const s = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
    return s.includes(trimmedCmd) && !bareRe.test(s) && !prefixRe.test(s);
  });
  if (!hasCanonicalLine) return lines;

  return lines.filter((line) => {
    const s = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (bareRe.test(s)) return false;
    if (prefixRe.test(s)) return false;
    return true;
  });
}

/**
 * Clean raw captured output for the AI model:
 * - Extract content between start marker and sentinel
 * - Remove sentinel/marker echo command lines
 * - Remove bare shell prompt lines
 * - Deduplicate command lines (keep only canonical "user host % command" form)
 */
export function cleanOutput(
  content: string,
  startMarker: string,
  sentinel: string,
  command?: string,
): string {
  const lines = content.split("\n");
  let startIdx = -1;
  let endIdx = -1;
  const sentinelWithDigitRegex = new RegExp(`${sentinel}\\d`);

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(startMarker)) startIdx = i;
    if (lines[i].match(sentinelWithDigitRegex)) endIdx = i;
  }

  let extracted: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    extracted = lines.slice(startIdx + 1, endIdx).join("\n");
  } else if (startIdx !== -1) {
    extracted = lines.slice(startIdx + 1).join("\n");
  } else if (endIdx !== -1) {
    extracted = lines.slice(0, endIdx).join("\n");
  } else {
    extracted = content;
  }

  const sentinelEchoRe = new RegExp(`echo\\s+${escapeForRegex(sentinel)}`);
  const startEchoRe = new RegExp(`echo\\s+${escapeForRegex(startMarker)}`);
  const promptRe = /^.*?[#$]\s*$/;

  let outputLines = extracted.split("\n");
  const filteredLines = outputLines.filter((line) => {
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (sentinelEchoRe.test(stripped)) return false;
    if (startEchoRe.test(stripped)) return false;
    if (stripped && promptRe.test(stripped)) return false;
    return true;
  });

  if (command) {
    outputLines = deduplicateCommandLines(filteredLines, command);
  } else {
    outputLines = filteredLines;
  }

  extracted = outputLines.join("\n");
  const cleaned = extracted.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}
