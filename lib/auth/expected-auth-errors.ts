const INVALID_GRANT_ERROR = "invalid_grant";
const SESSION_ENDED_MESSAGE = "session has already ended";
const SESSION_ENDED_DUE_TO_INACTIVITY_MESSAGE =
  "session ended due to inactivity";
const INVALID_CODE_VERIFIER_MESSAGE = "invalid code verifier";
const SIGN_IN_SESSION_UNVERIFIED_MESSAGE =
  "sign-in session could not be verified";

const getStringValue = (
  value: Record<string, unknown>,
  key: string,
): string | null => {
  const fieldValue = value[key];
  return typeof fieldValue === "string" ? fieldValue : null;
};

export const collectAuthErrorText = (
  value: unknown,
  seen = new Set<unknown>(),
  depth = 0,
): string => {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) {
    return "";
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const rawData =
    record.rawData && typeof record.rawData === "object"
      ? (record.rawData as Record<string, unknown>)
      : {};

  return [
    getStringValue(record, "name"),
    getStringValue(record, "message"),
    getStringValue(record, "error"),
    getStringValue(record, "errorDescription"),
    getStringValue(record, "error_description"),
    getStringValue(rawData, "error"),
    getStringValue(rawData, "errorDescription"),
    getStringValue(rawData, "error_description"),
    collectAuthErrorText(record.cause, seen, depth + 1),
  ]
    .filter((text): text is string => Boolean(text))
    .join("\n");
};

export const isEndedSessionRefreshError = (value: unknown): boolean => {
  const errorText = collectAuthErrorText(value).toLowerCase();
  return (
    errorText.includes(INVALID_GRANT_ERROR) &&
    (errorText.includes(SESSION_ENDED_MESSAGE) ||
      errorText.includes(SESSION_ENDED_DUE_TO_INACTIVITY_MESSAGE))
  );
};

export const isInvalidCodeVerifierError = (value: unknown): boolean => {
  const errorText = collectAuthErrorText(value).toLowerCase();
  return (
    errorText.includes(INVALID_GRANT_ERROR) &&
    errorText.includes(INVALID_CODE_VERIFIER_MESSAGE)
  );
};

export const isUnverifiedSignInSessionError = (value: unknown): boolean => {
  return collectAuthErrorText(value)
    .toLowerCase()
    .includes(SIGN_IN_SESSION_UNVERIFIED_MESSAGE);
};
