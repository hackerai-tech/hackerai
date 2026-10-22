import type { PostHog } from "posthog-js";
import { v5 as uuidv5 } from "uuid";
import { createFirstTouchAttribution } from "./acquisition";

export const X_REFERRAL_EVENT = "x_referral_visit";
const DEDUPE_KEY = "hackerai:x-referral:v1";

export function xReferringDomain(referrer: string): string | null {
  try {
    const url = new URL(referrer);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const domain = url.hostname.toLowerCase();
    return ["t.co", "x.com", "twitter.com"].some(
      (host) => domain === host || domain.endsWith(`.${host}`),
    )
      ? domain
      : null;
  } catch {
    return null;
  }
}

export function isXReferralLanding() {
  return (
    xReferringDomain(document.referrer) !== null &&
    !/bot|crawler|spider|slurp|headless|preview/i.test(navigator.userAgent)
  );
}

// One observed X arrival per browser identity/UTC day, not a pageview counter.
// Keep the anonymous SDK identity so identify() can join it to server payments.
export function captureXReferralVisit(posthog: PostHog): boolean {
  if (!isXReferralLanding()) return false;
  const day = new Date().toISOString().slice(0, 10);
  const uuid = uuidv5(
    `${X_REFERRAL_EVENT}:1:${posthog.get_distinct_id()}:${day}`,
    uuidv5.URL,
  );
  try {
    if (localStorage.getItem(DEDUPE_KEY) === uuid) return true;
  } catch {
    // The ingestion UUID still deduplicates when browser storage is unavailable.
  }
  const result = posthog.capture(
    X_REFERRAL_EVENT,
    {
      source: "x",
      referring_domain: xReferringDomain(document.referrer),
      entry_surface: createFirstTouchAttribution({
        url: new URL(window.location.href),
        referer: null,
      }).entrySurface,
      referral_event_version: 1,
      visit_utc_day: day,
    },
    { uuid },
  );
  if (!result) return false;
  try {
    localStorage.setItem(DEDUPE_KEY, uuid);
  } catch {
    // Best effort only; never block the visitor's journey on analytics storage.
  }
  return true;
}

export function clearXReferralDedupe() {
  try {
    localStorage.removeItem(DEDUPE_KEY);
  } catch {
    // Storage may be unavailable.
  }
}

const ALLOWED_PROPERTIES = new Set([
  "token",
  "distinct_id",
  "$device_id",
  "$session_id",
  "$window_id",
  "$is_identified",
  "$process_person_profile",
  "$lib",
  "$lib_version",
  "source",
  "referring_domain",
  "entry_surface",
  "referral_event_version",
  "visit_utc_day",
]);

// Run after SDK enrichment, including for signed-in X arrivals. Do not transmit
// URLs, query strings, post paths, person properties, or arbitrary superprops.
export function sanitizeXReferralEvent<
  T extends {
    event?: string;
    properties?: Record<string, unknown>;
    $set?: unknown;
    $set_once?: unknown;
  },
>(event: T): T {
  if (event.event !== X_REFERRAL_EVENT) return event;
  event.properties = {
    ...Object.fromEntries(
      Object.entries(event.properties ?? {}).filter(([key]) =>
        ALLOWED_PROPERTIES.has(key),
      ),
    ),
    $geoip_disable: true,
  };
  delete event.$set;
  delete event.$set_once;
  return event;
}
