import { createHash } from "node:crypto";
import { decode } from "gpt-tokenizer";
import { safeCountTokens, safeEncode } from "@/lib/token-utils";

export const OPEN_URL_OUTPUT_TOKENS = 12_000;

// Full Markdown preserves content that Reader's default article filter can omit.
// Remove navigation, not generic asides/headers that can contain advisory details.
export const JINA_CONTENT_HEADERS = {
  "X-Timeout": "30",
  "X-Base": "final",
  "X-Token-Budget": "200000",
  "X-Respond-With": "markdown",
  "X-Remove-Selector": 'nav, footer, [role="navigation"]',
  "X-Retain-Images": "none",
} as const;

export const getUrlContentFailure = (content: string): string | undefined => {
  // Inspect Reader metadata, not article text that may discuss CAPTCHA or errors.
  const metadata = content.split(/\r?\nMarkdown Content:\r?\n/, 1)[0];
  const upstreamStatus = metadata.match(
    /^Warning: Target URL returned error (\d{3})\b/m,
  )?.[1];
  if (upstreamStatus)
    return `The requested page returned HTTP ${upstreamStatus}.`;
  if (
    /^Warning: This page maybe requiring CAPTCHA\b/m.test(metadata) ||
    (/^Title: Just a moment\.\.\./m.test(metadata) &&
      /Performing security verification/i.test(content))
  ) {
    return "The requested page requires sign-in or browser security verification; no page content was retrieved.";
  }
  if (!content.trim()) return "The URL reader returned no page content.";
};

type ContentCursor = { offset: number; digest: string };

const parseCursor = (cursor: string): ContentCursor | undefined => {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) return;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Number.isSafeInteger(value?.offset) &&
      value.offset > 0 &&
      typeof value.digest === "string" &&
      /^[a-f0-9]{64}$/.test(value.digest)
    ) {
      return { offset: value.offset, digest: value.digest };
    }
  } catch {
    return;
  }
};

/** Consecutive, content-bound windows: no middle is discarded or summarized. */
export const formatUrlContentPage = (
  content: string,
  url: string,
  cursor?: string,
): string => {
  const position = cursor ? parseCursor(cursor) : undefined;
  if (cursor && !position) {
    return "Error opening URL: Invalid continuation cursor. Read the URL again without a cursor.";
  }
  const digest = createHash("sha256")
    .update(url)
    .update("\0")
    .update(content)
    .digest("hex");
  if (position && position.digest !== digest) {
    return "Error opening URL: Page content changed since the previous result. Read the URL again without a cursor; do not combine different page versions.";
  }
  const tokens = safeEncode(content);
  const start = position?.offset ?? 0;
  if (
    position &&
    (start >= tokens.length ||
      !content.startsWith(decode(tokens.slice(0, start))))
  ) {
    return "Error opening URL: Continuation cursor is beyond the page content. Read the URL again without a cursor.";
  }
  if (!position && tokens.length <= OPEN_URL_OUTPUT_TOKENS) return content;

  // Reserve room for metadata, then enforce the complete result's token budget.
  let end = Math.min(start + OPEN_URL_OUTPUT_TOKENS - 256, tokens.length);
  for (;;) {
    // Token boundaries can split a Unicode code point. Move back to an exact
    // source prefix so adjacent windows reconstruct the original text losslessly.
    while (end > start && !content.startsWith(decode(tokens.slice(0, end))))
      end--;
    const nextCursor = Buffer.from(
      JSON.stringify({ offset: end, digest }),
    ).toString("base64url");
    const footer =
      end < tokens.length
        ? `\n\n[More page content available. Call open_url with the same URL and cursor="${nextCursor}" to continue. Do not treat this partial page as complete.]`
        : "\n\n[End of page content.]";
    const result = `[Page content tokens ${start + 1}-${end} of ${tokens.length}]\n\n${decode(tokens.slice(start, end))}${footer}`;
    const overflow = safeCountTokens(result) - OPEN_URL_OUTPUT_TOKENS;
    if (overflow <= 0) return result;
    end -= overflow + 1;
  }
};
