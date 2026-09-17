import type { AnalyticsConsent } from "@/lib/privacy/analytics-consent";
import { validPartnerCode } from "./policy";

export function resolvePendingInfluencerReferral(
  browser: Pick<Window, "location">,
  consent: AnalyticsConsent | null,
) {
  if (!consent) return;
  const url = new URL(browser.location.href);
  const code = url.searchParams.get("ref")?.toLowerCase();
  if (!code || !validPartnerCode(code)) return;

  if (consent === "accepted") {
    // Reuse the server's partner validation, signed cookies and first-click
    // policy. Navigate only after the consent cookie has been saved.
    browser.location.replace(`/r/${code}`);
  } else {
    url.searchParams.delete("ref");
    // A full navigation avoids a Server Action refresh restoring the old URL.
    browser.location.replace(`${url.pathname}${url.search}${url.hash}`);
  }
}
