export const ANALYTICS_CONSENT_COOKIE_NAME = "hackerai_analytics_consent";
export const ANALYTICS_CONSENT_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

export type AnalyticsConsent = "accepted" | "declined";

export type AnalyticsConsentStatus = {
  consent: AnalyticsConsent | null;
  consentRequired: boolean;
};

const CONSENT_REQUIRED_COUNTRY_CODES = new Set([
  // European Union
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
  // Additional EEA countries and the United Kingdom
  "IS",
  "LI",
  "NO",
  "GB",
]);

export function parseAnalyticsConsent(
  value: string | null | undefined,
): AnalyticsConsent | null {
  return value === "accepted" || value === "declined" ? value : null;
}

export function countryCodeFromHeaders(headers: Headers): string | null {
  const rawCountryCode =
    headers.get("x-vercel-ip-country") ?? headers.get("cf-ipcountry");
  const countryCode = rawCountryCode?.trim().toUpperCase();
  return countryCode && countryCode !== "XX" && /^[A-Z]{2}$/.test(countryCode)
    ? countryCode
    : null;
}

export function requiresAnalyticsConsent({
  countryCode,
  failClosed = false,
}: {
  countryCode: string | null;
  failClosed?: boolean;
}): boolean {
  if (!countryCode) return failClosed;
  return CONSENT_REQUIRED_COUNTRY_CODES.has(countryCode.toUpperCase());
}

export function isAnalyticsAllowed({
  consent,
  consentRequired,
}: {
  consent: AnalyticsConsent | null;
  consentRequired: boolean;
}): boolean {
  if (consent === "declined") return false;
  return consent === "accepted" || !consentRequired;
}

export function getAnalyticsConsentDecision({
  cookieValue,
  countryCode,
  failClosed = false,
}: {
  cookieValue: string | null | undefined;
  countryCode: string | null;
  failClosed?: boolean;
}) {
  const consent = parseAnalyticsConsent(cookieValue);
  const consentRequired = requiresAnalyticsConsent({
    countryCode,
    failClosed,
  });

  return {
    consent,
    consentRequired,
    analyticsAllowed: isAnalyticsAllowed({ consent, consentRequired }),
  } as const;
}
