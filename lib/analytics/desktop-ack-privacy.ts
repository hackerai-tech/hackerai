import {
  NATIVE_AUTHORIZATION_CAUSE_PROPERTIES,
  NATIVE_AUTHORIZATION_CONNECTOR_PROPERTIES,
  NATIVE_AUTHORIZATION_DIAGNOSTIC_PROPERTIES,
  NATIVE_AUTHORIZATION_IO_PROPERTIES,
  NATIVE_AUTHORIZATION_MITIGATION_PROPERTIES,
  NATIVE_AUTHORIZATION_RESPONSE_PROPERTIES,
  NATIVE_AUTHORIZATION_RESPONSE_READ_PROPERTIES,
  NATIVE_AUTHORIZATION_RESPONSE_READ_TIMING_PROPERTIES,
  NATIVE_AUTHORIZATION_TRANSPORT_PROPERTIES,
  readNativeAuthorizationCause,
  readNativeAuthorizationConnector,
  readNativeAuthorizationDiagnostic,
  readNativeAuthorizationIo,
  readNativeAuthorizationMitigation,
  readNativeAuthorizationResponse,
  readNativeAuthorizationResponseRead,
  readNativeAuthorizationResponseReadTiming,
  readNativeAuthorizationTransport,
} from "./native-authorization-diagnostics";
import {
  DESKTOP_TERMINAL_ERROR_PROPERTIES,
  readDesktopTerminalErrorDiagnostic,
} from "./desktop-terminal-error-diagnostics";
import {
  DESKTOP_INVOCATION_ADMISSION_PROPERTIES,
  DESKTOP_INVOCATION_REJECTION_PROPERTIES,
  DESKTOP_INVOCATION_SPAWN_HINT_PROPERTIES,
  DESKTOP_INVOCATION_UNKNOWN_PROPERTIES,
  DESKTOP_STREAM_FENCE_PROPERTIES,
  readDesktopInvocationAdmissionDiagnostic,
  readDesktopInvocationRejectionDiagnostic,
  readDesktopInvocationSpawnHintDiagnostic,
  readDesktopInvocationUnknownDiagnostic,
  readDesktopStreamFenceDiagnostic,
  readDesktopStreamFenceRendererCancelDiagnostic,
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

/** One snapshot of `key` as an enumerable own data value, or null for an
 * absent, inherited, non-enumerable or accessor key. Never runs a getter and
 * never throws. */
function enumerableOwnData(
  source: object,
  key: string,
): { readonly value: unknown } | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor?.enumerable && "value" in descriptor
      ? { value: descriptor.value }
      : null;
  } catch {
    return null;
  }
}

/** Whether `source` has no `triggerRunId` of any kind, own or inherited.
 * Never runs a getter; a throwing proxy reads as having one. */
function lacksTriggerRunId(source: object): boolean {
  try {
    return !("triggerRunId" in source);
  } catch {
    return false;
  }
}

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
    // The read group joins only a valid `json_error` response group, likewise
    // only as the validated data copy; an invalid one is dropped alone.
    const nativeAuthorizationResponseRead = readNativeAuthorizationResponseRead(
      event.properties,
      nativeAuthorizationResponse,
    );
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
    // The read timing joins only a validated `timeout` read group beside its
    // 2xx `json_error` response group and an `authorization_response_invalid`
    // rejection class; no timing property is read without them. It likewise
    // survives only as the validated data copy and drops alone.
    const nativeAuthorizationResponseReadTiming =
      readNativeAuthorizationResponseReadTiming(
        event.properties,
        nativeAuthorizationResponse,
        nativeAuthorizationResponseRead,
        invocationRejection,
      );
    // The admission class joins only a validated execution_admission class,
    // likewise only as the validated data copy; an invalid one drops alone.
    const invocationAdmission = readDesktopInvocationAdmissionDiagnostic(
      event.properties,
      invocationRejection,
    );
    // The OS code hint joins only a validated spawn_failed class from a
    // selected native command set; no hint property is read without one. It
    // likewise survives only as the validated data copy and drops alone.
    const invocationSpawnHint = readDesktopInvocationSpawnHintDiagnostic(
      event.properties,
      invocationRejection,
    );
    // The unknown class joins only a validated `unknown` class from the
    // authorized command set; no unknown property is read without one. It
    // likewise survives only as the validated data copy and drops alone.
    const invocationUnknown = readDesktopInvocationUnknownDiagnostic(
      event.properties,
      invocationRejection,
    );
    // The stream fence origin joins only validated authorized unknown and
    // `lifecycle_stop_unconfirmed` groups; no fence property is read without
    // them. It likewise survives only as the validated data copy and drops
    // alone. An acknowledged stop or owner timeout can carry cleanup.
    // A tree-only failure can add its Windows taskkill result. Only an
    // explicit stop with a validated not-found report can add its first
    // request source. A cancellation-wait timeout can add its owner phase.
    // The acknowledgement that admits them is the same single snapshot that
    // is emitted: an inherited or accessor flag never admits them, is never
    // run and never survives the copy below.
    const acknowledgement =
      event.event === "desktop_ack_delivery_summary"
        ? null
        : enumerableOwnData(event.properties, "terminalAcknowledged");
    const streamFence = readDesktopStreamFenceDiagnostic(
      event.properties,
      invocationRejection,
      invocationUnknown,
      acknowledgement?.value === true,
    );
    const properties = event.properties;
    event.properties = Object.fromEntries(
      Object.keys(properties)
        .filter(
          (key) =>
            key !== "terminalAcknowledged" &&
            !NATIVE_AUTHORIZATION_DIAGNOSTIC_PROPERTIES.has(key) &&
            !NATIVE_AUTHORIZATION_CAUSE_PROPERTIES.has(key) &&
            !NATIVE_AUTHORIZATION_TRANSPORT_PROPERTIES.has(key) &&
            !NATIVE_AUTHORIZATION_IO_PROPERTIES.has(key) &&
            !NATIVE_AUTHORIZATION_CONNECTOR_PROPERTIES.has(key) &&
            !NATIVE_AUTHORIZATION_RESPONSE_PROPERTIES.has(key) &&
            !NATIVE_AUTHORIZATION_MITIGATION_PROPERTIES.has(key) &&
            !NATIVE_AUTHORIZATION_RESPONSE_READ_PROPERTIES.has(key) &&
            !NATIVE_AUTHORIZATION_RESPONSE_READ_TIMING_PROPERTIES.has(key) &&
            !DESKTOP_TERMINAL_ERROR_PROPERTIES.has(key) &&
            !DESKTOP_INVOCATION_REJECTION_PROPERTIES.has(key) &&
            !DESKTOP_INVOCATION_ADMISSION_PROPERTIES.has(key) &&
            !DESKTOP_INVOCATION_SPAWN_HINT_PROPERTIES.has(key) &&
            !DESKTOP_INVOCATION_UNKNOWN_PROPERTIES.has(key) &&
            !DESKTOP_STREAM_FENCE_PROPERTIES.has(key),
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
    // The renderer cancel attempt pair joins only that validated `cancel_ipc`
    // source of a final with no `triggerRunId` at all: neither emitted nor
    // dropped by this copy, nor inherited. It likewise survives only as the
    // validated data copy and drops alone.
    const streamFenceRendererCancel =
      readDesktopStreamFenceRendererCancelDiagnostic(
        properties,
        streamFence,
        !("triggerRunId" in event.properties) && lacksTriggerRunId(properties),
      );
    if (acknowledgement)
      event.properties.terminalAcknowledged = acknowledgement.value;
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
    if (nativeAuthorizationResponseRead)
      Object.assign(event.properties, nativeAuthorizationResponseRead);
    if (nativeAuthorizationResponseReadTiming)
      Object.assign(event.properties, nativeAuthorizationResponseReadTiming);
    if (terminalError) Object.assign(event.properties, terminalError);
    if (invocationRejection)
      Object.assign(event.properties, invocationRejection);
    if (invocationAdmission)
      Object.assign(event.properties, invocationAdmission);
    if (invocationSpawnHint)
      Object.assign(event.properties, invocationSpawnHint);
    if (invocationUnknown) Object.assign(event.properties, invocationUnknown);
    if (streamFence) Object.assign(event.properties, streamFence);
    if (streamFenceRendererCancel)
      Object.assign(event.properties, streamFenceRendererCancel);
  }
  delete event.$set;
  delete event.$set_once;
  return event;
}
