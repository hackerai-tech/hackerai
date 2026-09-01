import { describe, expect, it } from "@jest/globals";
import {
  countryCodeFromHeaders,
  getAnalyticsConsentDecision,
  isAnalyticsAllowed,
  parseAnalyticsConsent,
  requiresAnalyticsConsent,
} from "@/lib/privacy/analytics-consent";

describe("analytics consent", () => {
  it.each(["DE", "fr", "IE", "NO", "GB"])(
    "requires consent for %s",
    (countryCode) => {
      expect(requiresAnalyticsConsent({ countryCode })).toBe(true);
    },
  );

  it.each(["US", "CA", "AU", "CH"])(
    "does not require consent for %s by default",
    (countryCode) => {
      expect(requiresAnalyticsConsent({ countryCode })).toBe(false);
    },
  );

  it("can fail closed when country data is unavailable", () => {
    expect(
      requiresAnalyticsConsent({ countryCode: null, failClosed: true }),
    ).toBe(true);
    expect(requiresAnalyticsConsent({ countryCode: null })).toBe(false);
  });

  it("reads normalized Vercel and Cloudflare country headers", () => {
    expect(
      countryCodeFromHeaders(new Headers({ "x-vercel-ip-country": " de " })),
    ).toBe("DE");
    expect(countryCodeFromHeaders(new Headers({ cfipcountry: "FR" }))).toBe(
      null,
    );
    expect(countryCodeFromHeaders(new Headers({ "cf-ipcountry": "fr" }))).toBe(
      "FR",
    );
    expect(countryCodeFromHeaders(new Headers({ "cf-ipcountry": "XX" }))).toBe(
      null,
    );
  });

  it("rejects unknown consent cookie values", () => {
    expect(parseAnalyticsConsent("accepted")).toBe("accepted");
    expect(parseAnalyticsConsent("declined")).toBe("declined");
    expect(parseAnalyticsConsent("yes")).toBeNull();
  });

  it("requires an explicit opt-in in covered countries", () => {
    expect(
      getAnalyticsConsentDecision({
        cookieValue: undefined,
        countryCode: "DE",
      }),
    ).toEqual({
      consent: null,
      consentRequired: true,
      analyticsAllowed: false,
    });
    expect(
      getAnalyticsConsentDecision({
        cookieValue: "accepted",
        countryCode: "DE",
      }).analyticsAllowed,
    ).toBe(true);
  });

  it("honors a rejection even where prior opt-in is not required", () => {
    expect(
      isAnalyticsAllowed({ consent: "declined", consentRequired: false }),
    ).toBe(false);
  });
});
