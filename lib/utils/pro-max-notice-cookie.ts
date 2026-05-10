const COOKIE_NAME = "hackerai_pro_max_usage_ack";

/** Long-lived dismissal; informational only (not auth). */
const MAX_AGE_SEC = 60 * 60 * 24 * 365 * 5;

/**
 * Parses a `document.cookie`-style header so logic is testable without DOM.
 */
export const isProMaxUsageNoticeDismissedFromCookieHeader = (
  cookieHeader: string,
): boolean =>
  new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=1(?:;|$)`).test(cookieHeader);

export const isProMaxUsageNoticeDismissed = (): boolean => {
  if (typeof document === "undefined") return false;
  return isProMaxUsageNoticeDismissedFromCookieHeader(document.cookie);
};

export const dismissProMaxUsageNotice = (): void => {
  if (typeof document === "undefined") return;
  document.cookie = `${COOKIE_NAME}=1; path=/; max-age=${MAX_AGE_SEC}; SameSite=Lax`;
};
