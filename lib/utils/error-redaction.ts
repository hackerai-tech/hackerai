const REDACTED_VALUE = "[Redacted]";

const SENSITIVE_FIELD_PATTERN =
  /(["']?\b(?:serviceKey|service_key|apiKey|api_key|authorization|bearer|cookie|password|secret|token)\b["']?)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi;

const ENV_SECRET_PATTERN =
  /(["']?\b(?:CONVEX_SERVICE_ROLE_KEY|POSTHOG_API_KEY|STRIPE_SECRET_KEY)\b["']?)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi;

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
    });

export const stringifyRedactedError = (error: unknown): string => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return String(error);
            }
          })();

  return redactSensitiveErrorMessage(message);
};
