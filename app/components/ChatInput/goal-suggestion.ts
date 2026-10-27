/** Return the draft after selecting a standalone goal command, or null. */
export function getGoalSuggestionDraft(input: string): string | null {
  if (input.trim() === "/") return "";
  const match = /(^|\s)(\/g(?:o(?:a(?:l)?)?)?)(?=\s|$)/i.exec(input);
  if (!match) return null;

  const start = match.index + match[1].length;
  const before = input.slice(0, start);
  const after = input.slice(start + match[2].length);
  // Leading commands with arguments already have submit-time semantics,
  // including /goal pause, resume, and start. Leave those commands intact.
  if (!before.trim() && after.trim()) return null;

  // Remove the command and its redundant horizontal separator, preserving
  // the rest of the objective, including line breaks and contract fields.
  const suffix = /[^\S\r\n]$/.test(before)
    ? after.replace(/^[^\S\r\n]+/, "")
    : after;
  return (before + suffix).trim();
}
