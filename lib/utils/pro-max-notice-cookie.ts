const COOKIE_NAME = "hackerai_pro_max_usage_ack";

/** Long-lived dismissal for the Pro/Max high-cost notice; informational only. */
const MAX_AGE_SEC = 60 * 60 * 24 * 365 * 5;

/**
 * Parses a `document.cookie`-style header so logic is testable without DOM.
 */
export const isHighCostModelUsageNoticeDismissedFromCookieHeader = (
  cookieHeader: string,
): boolean =>
  new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=1(?:;|$)`).test(cookieHeader);

export const isHighCostModelUsageNoticeDismissed = (): boolean => {
  if (typeof document === "undefined") return false;
  return isHighCostModelUsageNoticeDismissedFromCookieHeader(document.cookie);
};

export const dismissHighCostModelUsageNotice = (): void => {
  if (typeof document === "undefined") return;
  document.cookie = `${COOKIE_NAME}=1; path=/; max-age=${MAX_AGE_SEC}; SameSite=Lax`;
};

export const isProMaxUsageNoticeDismissedFromCookieHeader =
  isHighCostModelUsageNoticeDismissedFromCookieHeader;
export const isProMaxUsageNoticeDismissed = isHighCostModelUsageNoticeDismissed;
export const dismissProMaxUsageNotice = dismissHighCostModelUsageNotice;
