const REDACTED_VALUE = "[Redacted]";

// Match credential suffixes (including camelCase and header spellings), not
// diagnostic fields such as tokenCount or max_tokens. The leading boundary
// avoids retrying the variable-length key match at every character of long text.
// Quoted values include escapes; unquoted values retain punctuation in secrets.
const SENSITIVE_FIELD_PATTERN =
  /(?<![\w-])(["']?\b[\w-]*(?:service[_-]?(?:role[_-]?)?key|api[_-]?key|secret[_-]?key|authorization|bearer|cookie|password|secret|token)\b["']?)(\s*[:=]\s*)(?:\\"(?:\\.|[^"\\])*(?:\\"|$)|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|(?:Bearer|Basic)[ \t]+[^\s,}]+|[^\s,}]+)/gi;

// Cover authorization credentials outside a key/value diagnostic as well.
const BEARER_CREDENTIAL_PATTERN = /\bBearer[ \t]+[\w.~+/=-]+/gi;

// Null markers retain stripped control boundaries and are transparent inside
// a key. Serialized JSON and diagnostic URLs can encode the separator too.
// biome-ignore lint/suspicious/noControlCharactersInRegex: internal control-boundary marker
const PROVIDER_KEY_CANDIDATE_PATTERN =
  /(?:(?<![A-Za-z0-9_-])|(?<=\\[nrtbf]|\\u[\da-fA-F]{4}|%[\da-fA-F]{2}))sk-[A-Za-z0-9_\x00-]+/g;

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

export const redactSensitiveErrorMessage = (message: string): string =>
  message
    .replace(ANSI_ESCAPE_PATTERN, "\0")
    .replace(CONTROL_CHARACTER_PATTERN, "\0")
    .replace(PROVIDER_KEY_CANDIDATE_PATTERN, (candidate) => {
      const key = candidate.replaceAll("\0", "");
      // Require at least 20 body characters, excluding control markers.
      return key.length >= 23 ? REDACTED_VALUE : candidate;
    })
    .replaceAll("\0", "")
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
