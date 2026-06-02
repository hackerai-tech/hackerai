const AUTHKIT_CALLBACK_ERROR_PREFIX = "[AuthKit callback error]";
const AUTH_COOKIE_MISSING_MESSAGE = "Auth cookie missing";
const INVALID_GRANT_ERROR = "invalid_grant";
const CODE_ALREADY_EXCHANGED_MESSAGE = "already been exchanged";

let activeSuppressions = 0;
let originalConsoleError: typeof console.error | null = null;

export const isAuthCookieMissingError = (value: unknown): boolean => {
  if (typeof value === "string") {
    return value.includes(AUTH_COOKIE_MISSING_MESSAGE);
  }

  if (value && typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    return (
      typeof message === "string" &&
      message.includes(AUTH_COOKIE_MISSING_MESSAGE)
    );
  }

  return false;
};

const getStringValue = (
  value: Record<string, unknown>,
  key: string,
): string | null => {
  const fieldValue = value[key];
  return typeof fieldValue === "string" ? fieldValue : null;
};

const collectErrorText = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  const rawData =
    record.rawData && typeof record.rawData === "object"
      ? (record.rawData as Record<string, unknown>)
      : {};

  return [
    getStringValue(record, "message"),
    getStringValue(record, "error"),
    getStringValue(record, "errorDescription"),
    getStringValue(rawData, "error"),
    getStringValue(rawData, "error_description"),
  ]
    .filter((text): text is string => Boolean(text))
    .join("\n");
};

export const isOauthCodeAlreadyExchangedError = (value: unknown): boolean => {
  const errorText = collectErrorText(value).toLowerCase();
  return (
    errorText.includes(INVALID_GRANT_ERROR) &&
    errorText.includes(CODE_ALREADY_EXCHANGED_MESSAGE)
  );
};

export const isRecoverableAuthkitCallbackError = (value: unknown): boolean => {
  return (
    isAuthCookieMissingError(value) || isOauthCodeAlreadyExchangedError(value)
  );
};

export const isRecoverableAuthkitCallbackErrorLog = (
  args: readonly unknown[],
): boolean => {
  return (
    args[0] === AUTHKIT_CALLBACK_ERROR_PREFIX &&
    args.some(isRecoverableAuthkitCallbackError)
  );
};

const filteredConsoleError: typeof console.error = (...args) => {
  if (isRecoverableAuthkitCallbackErrorLog(args)) {
    return;
  }

  (originalConsoleError ?? console.error)(...args);
};

export const withRecoverableAuthkitCallbackErrorSuppressed = async <T>(
  operation: () => T | Promise<T>,
): Promise<T> => {
  if (activeSuppressions === 0) {
    originalConsoleError = console.error;
    console.error = filteredConsoleError;
  }
  activeSuppressions += 1;

  try {
    return await operation();
  } finally {
    activeSuppressions -= 1;
    if (activeSuppressions === 0) {
      const restoreConsoleError = originalConsoleError;
      originalConsoleError = null;
      if (restoreConsoleError) {
        console.error = restoreConsoleError;
      }
    }
  }
};
