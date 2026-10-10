/**
 * Catch escaped paragraph/list separators in prose without rewriting evidence.
 * Literal escapes belong in code spans/blocks, where they must remain intact.
 */
export function hasEscapedProseFormatting(value: string): boolean {
  const prose = value
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, "")
    .replace(/`[^`]*(?:`|$)/g, "");
  return /(^|[^\\])\\(?:r\\)?n(?:\\(?:r\\)?n|[ \t]*\d+[.)][ \t])/.test(prose);
}

export const FINDING_PROSE_FORMAT_MESSAGE =
  "Use actual line breaks between prose paragraphs and numbered steps, not literal backslash-n separators. Preserve literal escapes inside Markdown code spans or fenced blocks; do not rewrite raw evidence or PoC code.";
