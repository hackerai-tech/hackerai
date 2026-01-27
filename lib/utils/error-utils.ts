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

/**
 * Extracts structured error details for logging to Axiom or other services.
 * Handles both standard Error objects and provider-specific error formats (AI SDK, etc.)
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
    details.responseBody = anyError.responseBody;
  }
  if ("isRetryable" in anyError) {
    details.isRetryable = anyError.isRetryable;
  }
  if ("data" in anyError) {
    details.providerData = anyError.data;
  }
  if ("cause" in anyError && anyError.cause) {
    details.cause = getErrorMessage(anyError.cause);
  }
  if ("code" in anyError) {
    details.errorCode = anyError.code;
  }

  return details;
};
