import {
  NATIVE_AUTHORIZATION_CAUSE_PROPERTIES,
  NATIVE_AUTHORIZATION_DIAGNOSTIC_PROPERTIES,
  readNativeAuthorizationCause,
  readNativeAuthorizationDiagnostic,
} from "./native-authorization-diagnostics";

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

export function isDesktopAckAge(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

const AGE_PROPERTIES = new Set([
  "oldestPendingAgeMs",
  "lastAcknowledgementAgeMs",
  "publishInFlightAgeMs",
]);

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
  "terminalExitCode",
  "telemetry_sampled",
  "telemetry_sample_rate",
  ...AGE_PROPERTIES,
]);

const SUMMARY_PROPERTIES = new Set([
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
  "hackerai_frontend_build_commit",
  "telemetrySessionId",
  "windowSequence",
  "telemetry_sample_rate",
  "windowStartedAt",
  "windowEndedAt",
  "startedCount",
  "settledCount",
  "acknowledgedCount",
  "canceledCount",
  "incompleteCount",
  "terminalErrorCount",
  "nonzeroExitCount",
  "retryEvidenceCount",
  "retryEvidenceAcknowledgedCount",
  "bufferLimitCount",
  "deadlineExceededCount",
  "ownershipLostCount",
  "stoppedCount",
  "publishFailureCount",
  "replayCount",
  "resumeCount",
  "pendingAtStart",
  "pendingAtEnd",
]);

/** Strip SDK enrichment from command details and cross-command summaries. */
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
    event.event !== "desktop_ack_command_settled" &&
    event.event !== "desktop_ack_delivery_summary"
  )
    return event;
  if (event.properties) {
    // Native authorization fields survive only as one complete v1 group on a
    // terminal-error final; any invalid member drops the whole group.
    const nativeAuthorization =
      event.event === "desktop_ack_command_settled" &&
      event.properties.terminalType === "error" &&
      readNativeAuthorizationDiagnostic(event.properties) !== null;
    // The cause group joins only a valid v1 group, and only as the validated
    // data copy. The original cause properties are never read (a getter never
    // runs) or forwarded.
    const nativeAuthorizationCause = nativeAuthorization
      ? readNativeAuthorizationCause(event.properties)
      : null;
    const properties = event.properties;
    event.properties = Object.fromEntries(
      Object.keys(properties)
        .filter((key) => !NATIVE_AUTHORIZATION_CAUSE_PROPERTIES.has(key))
        .map((key) => [key, properties[key]] as const)
        .filter(
          ([key, value]) =>
            (NATIVE_AUTHORIZATION_DIAGNOSTIC_PROPERTIES.has(key)
              ? nativeAuthorization
              : (event.event === "desktop_ack_delivery_summary"
                  ? SUMMARY_PROPERTIES
                  : ALLOWED_PROPERTIES
                ).has(key)) &&
            (!AGE_PROPERTIES.has(key) ||
              (event.event === "desktop_ack_command_settled" &&
                isDesktopAckAge(value))) &&
            (key !== "stopSource" ||
              (event.event === "desktop_ack_command_settled" &&
                event.properties?.reason === "stopped" &&
                event.properties?.outcome === "incomplete" &&
                isDesktopAckStopSource(value))),
        ),
    );
    if (nativeAuthorizationCause)
      Object.assign(event.properties, nativeAuthorizationCause);
  }
  delete event.$set;
  delete event.$set_once;
  return event;
}
