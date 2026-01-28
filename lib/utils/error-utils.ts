/**
 * Extracts a readable error message from any error type.
 */
export const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message: unknown }).message;
    return typeof msg === "string" ? msg : JSON.stringify(msg);
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};

const SENSITIVE_KEYS = new Set([
  "requestBodyValues",
  "prompt",
  "messages",
  "content",
  "text",
]);

/**
 * Removes sensitive user data from provider error objects.
 * Fields containing user prompts/messages are completely removed.
 * Uses WeakSet to guard against circular references.
 */
const removeSensitiveData = (data: unknown): unknown => {
  const seen = new WeakSet<object>();

  const recurse = (value: unknown): unknown => {
    if (value === null || value === undefined) return value;
    if (typeof value !== "object") return value;

    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map(recurse);
    }

    const obj = value as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.has(key)) {
        continue;
      }
      if (val && typeof val === "object") {
        cleaned[key] = recurse(val);
      } else {
        cleaned[key] = val;
      }
    }

    return cleaned;
  };

  return recurse(data);
};

/**
 * Extracts structured error details for logging to Axiom or other services.
 * Handles both standard Error objects and provider-specific error formats (AI SDK, etc.)
 * Sensitive user data (prompts, messages) is removed from the output.
 */
export const extractErrorDetails = (
  error: unknown,
): Record<string, unknown> => {
  const err = error instanceof Error ? error : null;
  const anyError = error as Record<string, unknown>;

  const details: Record<string, unknown> = {
    errorName: err?.name || "UnknownError",
    errorMessage: getErrorMessage(error),
  };

  // Add stack trace if available
  if (err?.stack) {
    details.errorStack = err.stack;
  }

  // Extract provider-specific error details (AI SDK format)
  if ("statusCode" in anyError) {
    details.statusCode = anyError.statusCode;
  }
  if ("url" in anyError) {
    details.providerUrl = anyError.url;
  }
  if ("responseBody" in anyError) {
    details.responseBody = removeSensitiveData(anyError.responseBody);
  }
  if ("isRetryable" in anyError) {
    details.isRetryable = anyError.isRetryable;
  }
  if ("data" in anyError) {
    details.providerData = removeSensitiveData(anyError.data);
  }
  if ("cause" in anyError && anyError.cause) {
    details.cause = getErrorMessage(anyError.cause);
  }
  if ("code" in anyError) {
    details.errorCode = anyError.code;
  }

  return details;
};
