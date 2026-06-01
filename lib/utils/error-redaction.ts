const REDACTED_VALUE = "[Redacted]";

const SENSITIVE_FIELD_PATTERN =
  /(["']?\b(?:serviceKey|service_key|apiKey|api_key|authorization|bearer|cookie|password|secret|token)\b["']?)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi;

const ENV_SECRET_PATTERN =
  /(["']?\b(?:CONVEX_SERVICE_ROLE_KEY|POSTHOG_API_KEY|STRIPE_SECRET_KEY)\b["']?)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi;

export const redactSensitiveErrorMessage = (message: string): string =>
  message
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
