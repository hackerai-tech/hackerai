import {
  NATIVE_AUTHORIZATION_CAUSE_PROPERTIES,
  NATIVE_AUTHORIZATION_CONNECTOR_PROPERTIES,
  NATIVE_AUTHORIZATION_DIAGNOSTIC_PROPERTIES,
  NATIVE_AUTHORIZATION_IO_PROPERTIES,
  NATIVE_AUTHORIZATION_MITIGATION_PROPERTIES,
  NATIVE_AUTHORIZATION_RESPONSE_PROPERTIES,
  NATIVE_AUTHORIZATION_TRANSPORT_PROPERTIES,
  readNativeAuthorizationCause,
  readNativeAuthorizationConnector,
  readNativeAuthorizationDiagnostic,
  readNativeAuthorizationIo,
  readNativeAuthorizationMitigation,
  readNativeAuthorizationResponse,
  readNativeAuthorizationTransport,
} from "./native-authorization-diagnostics";
import {
  DESKTOP_TERMINAL_ERROR_PROPERTIES,
  readDesktopTerminalErrorDiagnostic,
} from "./desktop-terminal-error-diagnostics";
import {
  DESKTOP_INVOCATION_REJECTION_PROPERTIES,
  readDesktopInvocationRejectionDiagnostic,
} from "./desktop-invocation-rejection-diagnostics";

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
    const nativeAuthorizationDiagnostic =
      event.event === "desktop_ack_command_settled" &&
      event.properties.terminalType === "error"
        ? readNativeAuthorizationDiagnostic(event.properties)
        : null;
    const nativeAuthorization = nativeAuthorizationDiagnostic !== null;
    // The cause group joins only a valid v1 group, and only as the validated
    // data copy. The original cause properties are never read (a getter never
    // runs) or forwarded.
    const nativeAuthorizationCause = nativeAuthorization
      ? readNativeAuthorizationCause(event.properties)
      : null;
    // The transport group joins a valid v1 group the same way, independently
    // of the cause group.
    const nativeAuthorizationTransport = nativeAuthorization
      ? readNativeAuthorizationTransport(event.properties)
      : null;
    // The IO group joins only those validated groups, when they describe the
    // same unmapped first IO error; likewise only as the validated data copy.
    const nativeAuthorizationIo = readNativeAuthorizationIo(event.properties, {
      diagnostic: nativeAuthorizationDiagnostic,
      cause: nativeAuthorizationCause,
      transport: nativeAuthorizationTransport,
    });
    // The connector group joins a valid v1 group the same way; an invalid one
    // is dropped alone and never defaults to a phase.
    const nativeAuthorizationConnector = nativeAuthorization
      ? readNativeAuthorizationConnector(event.properties)
      : null;
    // The response group is validated on its own, as the same kind of data
    // copy; its validity neither depends on nor admits the send groups.
    const nativeAuthorizationResponse =
      event.event === "desktop_ack_command_settled" &&
      event.properties.terminalType === "error"
        ? readNativeAuthorizationResponse(event.properties)
        : null;
    // The mitigation group joins only a valid response group, likewise only
    // as the validated data copy.
    const nativeAuthorizationMitigation = nativeAuthorizationResponse
      ? readNativeAuthorizationMitigation(event.properties)
      : null;
    // The terminal error kind is independent of every native authorization
    // group, and likewise survives only as the validated data copy.
    const terminalError =
      event.event === "desktop_ack_command_settled" &&
      event.properties.terminalType === "error"
        ? readDesktopTerminalErrorDiagnostic(event.properties)
        : null;
    // The rejection message class joins only a validated invocation_rejected
    // kind, and likewise survives only as the validated data copy.
    const invocationRejection =
      terminalError?.desktop_terminal_error_kind === "invocation_rejected"
        ? readDesktopInvocationRejectionDiagnostic(event.properties)
        : null;
    const properties = event.properties;
    event.properties = Object.fromEntries(
      Object.keys(properties)
        .filter(
          (key) =>
            !NATIVE_AUTHORIZATION_DIAGNOSTIC_PROPERTIES.has(key) &&
            !NATIVE_AUTHORIZATION_CAUSE_PROPERTIES.has(key) &&
            !NATIVE_AUTHORIZATION_TRANSPORT_PROPERTIES.has(key) &&
            !NATIVE_AUTHORIZATION_IO_PROPERTIES.has(key) &&
            !NATIVE_AUTHORIZATION_CONNECTOR_PROPERTIES.has(key) &&
            !NATIVE_AUTHORIZATION_RESPONSE_PROPERTIES.has(key) &&
            !NATIVE_AUTHORIZATION_MITIGATION_PROPERTIES.has(key) &&
            !DESKTOP_TERMINAL_ERROR_PROPERTIES.has(key) &&
            !DESKTOP_INVOCATION_REJECTION_PROPERTIES.has(key),
        )
        .map((key) => [key, properties[key]] as const)
        .filter(
          ([key, value]) =>
            (event.event === "desktop_ack_delivery_summary"
              ? SUMMARY_PROPERTIES
              : ALLOWED_PROPERTIES
            ).has(key) &&
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
    // Copy the same validated send snapshot used by the joined receipts.
    if (nativeAuthorizationDiagnostic)
      Object.assign(event.properties, nativeAuthorizationDiagnostic);
    if (nativeAuthorizationCause)
      Object.assign(event.properties, nativeAuthorizationCause);
    if (nativeAuthorizationTransport)
      Object.assign(event.properties, nativeAuthorizationTransport);
    if (nativeAuthorizationIo)
      Object.assign(event.properties, nativeAuthorizationIo);
    if (nativeAuthorizationConnector)
      Object.assign(event.properties, nativeAuthorizationConnector);
    if (nativeAuthorizationResponse)
      Object.assign(event.properties, nativeAuthorizationResponse);
    if (nativeAuthorizationMitigation)
      Object.assign(event.properties, nativeAuthorizationMitigation);
    if (terminalError) Object.assign(event.properties, terminalError);
    if (invocationRejection)
      Object.assign(event.properties, invocationRejection);
  }
  delete event.$set;
  delete event.$set_once;
  return event;
}
