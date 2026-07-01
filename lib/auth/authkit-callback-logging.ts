import {
  collectAuthErrorText,
  isInvalidCodeVerifierError,
  isUnverifiedSignInSessionError,
} from "./expected-auth-errors";

const AUTHKIT_CALLBACK_ERROR_PREFIX = "[AuthKit callback error]";
const AUTH_COOKIE_MISSING_MESSAGE = "Auth cookie missing";
const MISSING_REQUIRED_AUTH_PARAMETER_MESSAGE =
  "Missing required auth parameter";
const OAUTH_STATE_MISMATCH_MESSAGE = "OAuth state mismatch";
const INVALID_GRANT_ERROR = "invalid_grant";
const CODE_ALREADY_EXCHANGED_MESSAGE = "already been exchanged";
const VERIFIER_SCHEMA_KEYS = ['"nonce"', '"codeVerifier"'];

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

export const isOauthCodeAlreadyExchangedError = (value: unknown): boolean => {
  const errorText = collectAuthErrorText(value).toLowerCase();
  return (
    errorText.includes(INVALID_GRANT_ERROR) &&
    errorText.includes(CODE_ALREADY_EXCHANGED_MESSAGE)
  );
};

export const isMissingRequiredAuthParameterError = (
  value: unknown,
): boolean => {
  return collectAuthErrorText(value)
    .toLowerCase()
    .includes(MISSING_REQUIRED_AUTH_PARAMETER_MESSAGE.toLowerCase());
};

export const isOAuthStateMismatchError = (value: unknown): boolean => {
  return collectAuthErrorText(value)
    .toLowerCase()
    .includes(OAUTH_STATE_MISMATCH_MESSAGE.toLowerCase());
};

export const isAuthVerifierMissingError = (value: unknown): boolean => {
  if (value && typeof value === "object") {
    const error = value as {
      issues?: Array<{ expected?: string; received?: string }>;
    };
    if (
      error.issues?.some(
        (issue) =>
          VERIFIER_SCHEMA_KEYS.includes(issue.expected ?? "") &&
          issue.received === "undefined",
      )
    ) {
      return true;
    }
  }

  const errorText = collectAuthErrorText(value);
  return VERIFIER_SCHEMA_KEYS.some(
    (key) =>
      errorText.includes(`Expected ${key}`) &&
      errorText.includes("received undefined"),
  );
};

export const isRecoverableAuthkitCallbackError = (value: unknown): boolean => {
  return (
    isAuthCookieMissingError(value) ||
    isOauthCodeAlreadyExchangedError(value) ||
    isInvalidCodeVerifierError(value) ||
    isUnverifiedSignInSessionError(value) ||
    isMissingRequiredAuthParameterError(value) ||
    isOAuthStateMismatchError(value) ||
    isAuthVerifierMissingError(value)
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
