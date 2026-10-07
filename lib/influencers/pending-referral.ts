import type { AnalyticsConsent } from "@/lib/privacy/analytics-consent";
import { validPartnerCode } from "./policy";

export function resolvePendingInfluencerReferral(
  browser: Pick<Window, "location">,
  consent: AnalyticsConsent | null,
) {
  if (!consent) return;
  const url = new URL(browser.location.href);
  if (!url.searchParams.has("ref")) return;

  if (consent === "declined") {
    url.searchParams.delete("ref");
    // A full navigation avoids a Server Action refresh restoring the old URL.
    // Use the absolute same-origin URL even if the pathname starts with //.
    browser.location.replace(url.toString());
    return;
  }

  const code = url.searchParams.get("ref")?.toLowerCase();
  if (!code || !validPartnerCode(code)) return;
  // Reuse the server's partner validation, signed cookies and first-click
  // policy. Navigate only after the consent cookie has been saved.
  browser.location.replace(`/r/${code}`);
}
