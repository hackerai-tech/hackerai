const REDACTED_VALUE = "[Redacted]";

// Match credential suffixes (including camelCase and header spellings), not
// diagnostic fields such as tokenCount or max_tokens. The leading boundary
// avoids retrying the variable-length key match at every character of long text.
// Quoted values include escapes; unquoted values retain punctuation in secrets.
const SENSITIVE_FIELD_PATTERN =
  /(?<![\w-])(["']?\b[\w-]*(?:service[_-]?(?:role[_-]?)?key|api[_-]?key|secret[_-]?key|authorization|bearer|cookie|password|secret|token)\b["']?)(\s*[:=]\s*)(?:\\"(?:\\.|[^"\\])*(?:\\"|$)|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|(?:Bearer|Basic)[ \t]+[^\s,}]+|[^\s,}]+)/gi;

// Cover authorization credentials outside a key/value diagnostic as well.
const BEARER_CREDENTIAL_PATTERN = /\bBearer[ \t]+[\w.~+/=-]+/gi;

// These fixed Unicode whitespace characters can appear URI- or JSON-encoded
// before a key. Only constants enter the pattern; diagnostic text never does.
const ENCODED_UNICODE_WHITESPACE = Array.from(
  "\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff",
)
  .flatMap((character) => [
    encodeURIComponent(character),
    String.raw`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  ])
  .map((encoded) =>
    encoded.replace(
      /[a-f]/gi,
      (hex) => `[${hex.toLowerCase()}${hex.toUpperCase()}]`,
    ),
  )
  .join("|");

// Null markers retain stripped control boundaries and are transparent inside
// a key. Encoded ASCII boundaries exclude identifier characters.
const PROVIDER_KEY_CANDIDATE_PATTERN = new RegExp(
  String.raw`(?:(?<![A-Za-z0-9_-])|(?<=\\[nrtbf]|(?:%|\\u00)(?:[01][\da-fA-F]|2[\da-cA-Ce-fE-F]|3[a-fA-F]|40|5[b-eB-E]|60|7[b-fB-F])|${ENCODED_UNICODE_WHITESPACE}))s\x00*k\x00*-[A-Za-z0-9_\x00-]+`,
  "g",
);

// Redact every conventional environment assignment, not a small provider list.
const ENV_SECRET_PATTERN =
  /(?<![\w-])(["']?\b(?:[A-Z][A-Z0-9]*_[A-Z0-9_]+)\b["']?)(\s*[:=]\s*)(?:\\"(?:\\.|[^"\\])*(?:\\"|$)|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,}]+)/g;

const URL_PATTERN = /https?:\/\/[^\s"<>\\]+/gi;
const SIGNED_URL_CREDENTIAL_PATTERN =
  /[?&](?:x-amz-(?:algorithm|credential|date|expires|signedheaders|signature|security-token)|awsaccesskeyid|signature)=/i;
const REDACTED_SIGNED_URL = "[Redacted signed URL]";

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI/control-sequence cleanup for model/log-facing errors
const ANSI_ESCAPE_PATTERN =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-byte cleanup for model/log-facing errors
const CONTROL_CHARACTER_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export const stripControlSequencesFromErrorMessage = (
  message: string,
): string =>
  message
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CONTROL_CHARACTER_PATTERN, "");

export const redactSensitiveErrorMessage = (message: string): string => {
  // Discover complete keys before normalization can erase their boundaries.
  const marked = message
    .replace(ANSI_ESCAPE_PATTERN, "\0")
    .replace(CONTROL_CHARACTER_PATTERN, "\0");
  const keys = new Set(
    Array.from(marked.matchAll(PROVIDER_KEY_CANDIDATE_PATTERN), (match) =>
      match[0].replaceAll("\0", ""),
    ).filter((key) => key.length >= 23),
  );

  // Preserve whole-URL and credential-field handling before replacing any key
  // text that might itself be a field name or part of a URL.
  let redacted = stripControlSequencesFromErrorMessage(message)
    .replace(URL_PATTERN, (url) => {
      if (!SIGNED_URL_CREDENTIAL_PATTERN.test(url)) return url;

      // Apostrophes are valid inside object paths, but a terminal apostrophe
      // after the signed query is a surrounding string delimiter.
      const trailingDelimiter = url.endsWith("'") ? "'" : "";
      return `${REDACTED_SIGNED_URL}${trailingDelimiter}`;
    })
    .replace(SENSITIVE_FIELD_PATTERN, (_match, key, separator) => {
      return `${key}${separator}"${REDACTED_VALUE}"`;
    })
    .replace(ENV_SECRET_PATTERN, (_match, key, separator) => {
      return `${key}${separator}"${REDACTED_VALUE}"`;
    })
    .replace(BEARER_CREDENTIAL_PATTERN, `Bearer ${REDACTED_VALUE}`);

  // Longest first prevents a shared prefix leaving a longer key's suffix behind.
  // Once identified as a key, remove every occurrence, including echoed copies.
  for (const key of [...keys].sort((a, b) => b.length - a.length)) {
    redacted = redacted.replaceAll(key, REDACTED_VALUE);
  }
  return redacted;
};

export const stringifyRedactedError = (error: unknown): string => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (() => {
            try {
              return (
                JSON.stringify(error, (_key, value) =>
                  typeof value === "string"
                    ? redactSensitiveErrorMessage(value)
                    : value,
                ) ?? "Unknown error occurred"
              );
            } catch {
              return String(error);
            }
          })();

  return redactSensitiveErrorMessage(message);
};
