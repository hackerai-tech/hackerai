import type { PostHog } from "posthog-js";
import {
  INFLUENCER_VISIT_COOKIE,
  INFLUENCER_VISIT_EVENT,
  parseInfluencerVisit,
} from "./visit-handoff";

export function pendingInfluencerVisit() {
  const value = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${INFLUENCER_VISIT_COOKIE}=`))
    ?.slice(INFLUENCER_VISIT_COOKIE.length + 1);
  return parseInfluencerVisit(value);
}

export function clearInfluencerVisit() {
  document.cookie = `${INFLUENCER_VISIT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

/** Best-effort visit measurement; signed backend cookies own attribution. */
export function captureInfluencerVisit(posthog: PostHog) {
  const visit = pendingInfluencerVisit();
  if (!visit) return;
  // Consume before capture so remounts/reloads cannot count the same arrival.
  clearInfluencerVisit();
  if (/bot|crawler|spider|slurp|headless|preview/i.test(navigator.userAgent))
    return;
  try {
    posthog.capture(
      INFLUENCER_VISIT_EVENT,
      {
        distinct_id: `influencer-visitor:${visit.visitorId}`,
        $insert_id: visit.visitId,
        influencer_code: visit.code,
        referral_program: "influencer",
        analytics_version: 1,
        environment: visit.environment,
      },
      { uuid: visit.visitId, timestamp: new Date(visit.timestamp) },
    );
  } catch {
    // Optional telemetry must not interrupt the normal account analytics setup.
  }
}

const ALLOWED_PROPERTIES = new Set([
  "token",
  "distinct_id",
  "$insert_id",
  "influencer_code",
  "referral_program",
  "analytics_version",
  "environment",
]);

/** Strip SDK enrichment, including signed-in account identity and person updates. */
export function sanitizeInfluencerVisit<
  T extends {
    properties?: Record<string, unknown>;
    $set?: unknown;
    $set_once?: unknown;
  },
>(event: T): T {
  event.properties = {
    ...Object.fromEntries(
      Object.entries(event.properties ?? {}).filter(([key]) =>
        ALLOWED_PROPERTIES.has(key),
      ),
    ),
    $process_person_profile: false,
    $geoip_disable: true,
  };
  delete event.$set;
  delete event.$set_once;
  return event;
}
