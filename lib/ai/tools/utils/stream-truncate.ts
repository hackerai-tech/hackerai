/**
 * Truncates streaming output to stay within a character limit.
 * Accumulates output and forwards only up to maxChars, then stops.
 */

export const MAX_STREAM_OUTPUT_CHARS = 4096;

const STREAM_TRUNCATION_SUFFIX = "\n\n...[output truncated]";

/**
 * Creates a stream callback that accumulates output and forwards only up to
 * maxChars characters. Once the limit is reached, no further output is sent.
 */
export const createTruncatingStreamCallback = (
  write: (text: string) => void,
  maxChars = MAX_STREAM_OUTPUT_CHARS,
): ((text: string) => void) => {
  let totalSent = 0;

  return (text: string) => {
    if (totalSent >= maxChars) return;

    const remaining = maxChars - totalSent;
    if (text.length <= remaining) {
      write(text);
      totalSent += text.length;
      return;
    }

    const suffix = STREAM_TRUNCATION_SUFFIX;
    const contentBudget = Math.max(0, remaining - suffix.length);
    write(text.slice(0, contentBudget) + suffix);
    totalSent = maxChars;
  };
};
