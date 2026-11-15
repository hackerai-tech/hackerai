import {
  getIdentifiedAnalyticsUserId,
  subscribeAuthenticatedAnalytics,
} from "@/lib/analytics/client";
import {
  MESSAGE_TIMESTAMP_PHASES,
  type MessageTimestampPhase,
} from "@/lib/utils/message-time";

let subscribed = false;
let recent:
  { owner: string; phase: MessageTimestampPhase; at: number } | undefined;

/** Retain only the last finite phase after identification; never retain the date or error. */
export function recordMessageTimestampFailure(phase: MessageTimestampPhase) {
  try {
    if (!subscribed) {
      subscribeAuthenticatedAnalytics(() => {
        recent = undefined;
      });
      subscribed = true;
    }
    const owner = getIdentifiedAnalyticsUserId();
    if (!owner) {
      recent = undefined;
      return;
    }
    if (!MESSAGE_TIMESTAMP_PHASES.includes(phase)) return;
    const at = performance.now();
    if (!Number.isFinite(at) || at < 0) {
      recent = undefined;
      return;
    }
    recent = { owner, phase, at };
  } catch {
    recent = undefined;
    // Diagnostic state cannot interrupt rendering or replace its exception.
  }
}

/** Nearby capture-time context, not proof this formatter caused the captured exception. */
export function getRecentMessageTimestampDiagnostics(): Record<
  string,
  string | number
> {
  try {
    const owner = getIdentifiedAnalyticsUserId();
    if (!owner || !recent || recent.owner !== owner) {
      recent = undefined;
      return {};
    }
    const age = performance.now() - recent.at;
    if (!Number.isFinite(age) || age < 0 || age >= 5000) {
      recent = undefined;
      return {};
    }
    return {
      hackerai_recent_formatter_version: 1,
      hackerai_recent_formatter_phase: recent.phase,
      hackerai_recent_formatter_age:
        age < 100 ? "lt_100ms" : age < 1000 ? "lt_1s" : "lt_5s",
    };
  } catch {
    recent = undefined;
    return {};
  }
}
