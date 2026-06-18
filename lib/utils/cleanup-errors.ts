const CLEANUP_ALREADY_GONE_PATTERNS = [
  /\bnot[_\s-]?found\b/i,
  /\bno such (?:process|file|session|container|sandbox)\b/i,
  /\bdoes not exist\b/i,
  /\balready (?:closed|deleted|exited|gone|killed|removed|stopped)\b/i,
  /\b(?:process|session|container|sandbox).{0,60}(?:not found|closed|deleted|exited|gone|killed|removed|stopped)\b/i,
  /\b(?:connection|channel|socket|stream).{0,40}(?:closed|ended|gone|lost)\b/i,
  /\bESRCH\b/i,
] as const;

const collectCleanupErrorText = (
  error: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): string[] => {
  if (typeof error === "string") return [error];
  if (typeof error === "number") return [String(error)];
  if (!error || typeof error !== "object") return [];
  if (seen.has(error) || depth > 3) return [];
  seen.add(error);

  const record = error as Record<string, unknown>;
  const texts: string[] = [];
  for (const key of [
    "name",
    "message",
    "code",
    "status",
    "statusText",
    "responseBody",
  ] as const) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") {
      texts.push(String(value));
    }
  }

  for (const key of ["cause", "error"] as const) {
    const nested = record[key];
    if (nested !== undefined) {
      texts.push(...collectCleanupErrorText(nested, seen, depth + 1));
    }
  }

  return texts;
};

export const isExpectedAlreadyGoneCleanupError = (error: unknown): boolean => {
  const text = collectCleanupErrorText(error).join(" ");
  if (!text) return false;
  return CLEANUP_ALREADY_GONE_PATTERNS.some((pattern) => pattern.test(text));
};
