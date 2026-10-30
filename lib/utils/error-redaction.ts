const REDACTED_VALUE = "[Redacted]";

// Match credential suffixes (including camelCase and header spellings), not
// diagnostic fields such as tokenCount or max_tokens. The leading boundary
// avoids retrying the variable-length key match at every character of long text.
// Quoted values include escapes; unquoted values retain punctuation in secrets.
const SENSITIVE_FIELD_PATTERN =
  /(?<![\w-])(["']?\b[\w-]*(?:service[_-]?(?:role[_-]?)?key|api[_-]?key|secret[_-]?key|authorization|bearer|cookie|password|secret|token)\b["']?)(\s*[:=]\s*)(?:\\"(?:\\.|[^"\\])*(?:\\"|$)|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|(?:Bearer|Basic)[ \t]+[^\s,}]+|[^\s,}]+)/gi;

// Cover authorization credentials outside a key/value diagnostic as well.
const BEARER_CREDENTIAL_PATTERN = /\bBearer[ \t]+[\w.~+/-]+=*/gi;

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
  stripControlSequencesFromErrorMessage(message)
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
              return JSON.stringify(error) ?? "Unknown error occurred";
            } catch {
              return String(error);
            }
          })();

  return redactSensitiveErrorMessage(message);
};
