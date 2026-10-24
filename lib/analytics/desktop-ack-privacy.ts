const STOP_SOURCES = [
  "bridge_stop",
  "command_cleanup",
  "unauthenticated",
  "connection_not_found",
  "ownership_mismatch",
  "session_replaced",
  "connection_inactive",
  "transport_disconnected",
] as const;

export type DesktopAckStopSource = (typeof STOP_SOURCES)[number];

export function isDesktopAckStopSource(
  value: unknown,
): value is DesktopAckStopSource {
  return STOP_SOURCES.some((source) => source === value);
}

// PostHog enriches captures with URL, attribution and registered properties.
// Filter at before_send, after that enrichment, as well as at capture time.
const ALLOWED_PROPERTIES = new Set([
  "token",
  "distinct_id",
  "$session_id",
  "$window_id",
  "$is_identified",
  "$process_person_profile",
  "$lib",
  "$lib_version",
  "schemaVersion",
  "outputProtocol",
  "connectionId",
  "commandId",
  "chatId",
  "triggerRunId",
  "hackerai_frontend_build_commit",
  "outcome",
  "reason",
  "stopSource",
  "observedFrames",
  "enqueuedFrames",
  "acknowledgedFrames",
  "publishAttempts",
  "replayAttempts",
  "publishFailures",
  "resumeRequests",
  "pendingFrames",
  "pendingBytes",
  "peakPendingBytes",
  "terminalType",
  "terminalAcknowledged",
  "durationMs",
]);

export function sanitizeDesktopAckEvent<
  T extends {
    event?: string;
    properties?: Record<string, unknown>;
    $set?: unknown;
    $set_once?: unknown;
  },
>(event: T): T {
  if (
    event.event !== "desktop_ack_command_started" &&
    event.event !== "desktop_ack_command_settled"
  )
    return event;
  if (event.properties) {
    event.properties = Object.fromEntries(
      Object.entries(event.properties).filter(
        ([key, value]) =>
          ALLOWED_PROPERTIES.has(key) &&
          (key !== "stopSource" ||
            (event.event === "desktop_ack_command_settled" &&
              event.properties?.reason === "stopped" &&
              event.properties?.outcome === "incomplete" &&
              isDesktopAckStopSource(value))),
      ),
    );
  }
  delete event.$set;
  delete event.$set_once;
  return event;
}
