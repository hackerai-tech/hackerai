import { isPlatformRequestId } from "@/lib/platform-request-id";

export const AGENT_START_HTTP413_DIAGNOSTIC_EVENT =
  "agent_start_http413_diagnostic";
export const AGENT_START_HTTP413_DIAGNOSTIC_VERSION = 1;
/**
 * Bounds diagnostic work only; the request itself is never limited. Each
 * UTF-16 code unit encodes to at most three UTF-8 bytes.
 */
export const AGENT_START_BODY_SCAN_LIMIT_CODE_UNITS = 8 * 1024 * 1024;
export const AGENT_START_BODY_MAX_UTF8_BYTES =
  AGENT_START_BODY_SCAN_LIMIT_CODE_UNITS * 3;

export type AgentStartRequestBodyState =
  "measured" | "unmeasured_budget" | "unmeasured_unsupported" | "absent";
/** "known" is only the exact expected literal; anything else is "other". */
export type AgentStartHeaderMarkerState =
  "known" | "absent" | "other" | "unreadable";
export type AgentStartRequestIdState =
  "valid" | "absent" | "invalid" | "unreadable";

const BODY_STATES = new Set([
  "measured",
  "unmeasured_budget",
  "unmeasured_unsupported",
  "absent",
]);
const MARKER_STATES = new Set(["known", "absent", "other", "unreadable"]);
const REQUEST_ID_STATES = new Set(["valid", "absent", "invalid", "unreadable"]);

/** The compiled 40-hex frontend commit; this event is not auto-tagged. */
export function getAgentStartBuildContext():
  | { build_state: "measured"; hackerai_frontend_build_commit: string }
  | { build_state: "unavailable" } {
  const buildCommit = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
  return typeof buildCommit === "string" && /^[0-9a-f]{40}$/i.test(buildCommit)
    ? {
        build_state: "measured",
        hackerai_frontend_build_commit: buildCommit.toLowerCase(),
      }
    : { build_state: "unavailable" };
}

/** Read an own data property without invoking accessors. Proxy traps may throw. */
function readOwnData(target: unknown, key: string): { value: unknown } | null {
  if (typeof target !== "object" || target === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && "value" in descriptor
    ? { value: descriptor.value }
    : null;
}

function isClosed(values: Set<string>, value: unknown): value is string {
  return typeof value === "string" && values.has(value);
}

function isByteCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= AGENT_START_BODY_MAX_UTF8_BYTES
  );
}

/**
 * The single schema for this event. Rebuilds only known finite fields; any
 * missing, malformed or inconsistent field rejects the whole diagnostic.
 */
export function projectAgentStartHttp413Diagnostic(
  read: (key: string) => unknown,
): Record<string, unknown> | null {
  const version = read("agent_start_http413_diagnostic_version");
  const status = read("http_status");
  const bodyState = read("request_body_state");
  const bodyBytes = read("request_body_utf8_bytes");
  const appMarker = read("app_rejection_marker_state");
  const vercelError = read("vercel_error_state");
  const requestIdState = read("platform_request_id_state");
  const requestId = read("platform_request_id");
  const buildState = read("build_state");
  const buildCommit = read("hackerai_frontend_build_commit");
  const denominatorKind = read("attempt_denominator_kind");

  if (version !== AGENT_START_HTTP413_DIAGNOSTIC_VERSION) return null;
  if (status !== 413) return null;
  if (!isClosed(BODY_STATES, bodyState)) return null;
  if (
    bodyState === "measured" ? !isByteCount(bodyBytes) : bodyBytes !== undefined
  )
    return null;
  if (!isClosed(MARKER_STATES, appMarker)) return null;
  if (!isClosed(MARKER_STATES, vercelError)) return null;
  if (!isClosed(REQUEST_ID_STATES, requestIdState)) return null;
  if (
    requestIdState === "valid"
      ? !isPlatformRequestId(requestId)
      : requestId !== undefined
  )
    return null;
  // Native capture overwrites an invalid build commit with null.
  const build =
    buildState === "measured" &&
    typeof buildCommit === "string" &&
    /^[0-9a-f]{40}$/.test(buildCommit)
      ? { build_state: "measured", hackerai_frontend_build_commit: buildCommit }
      : buildState === "unavailable" &&
          (buildCommit === undefined || buildCommit === null)
        ? { build_state: "unavailable" }
        : null;
  if (!build) return null;
  if (denominatorKind !== "unmeasured") return null;

  return {
    agent_start_http413_diagnostic_version: version,
    http_status: status,
    request_body_state: bodyState,
    ...(bodyState === "measured" && { request_body_utf8_bytes: bodyBytes }),
    app_rejection_marker_state: appMarker,
    vercel_error_state: vercelError,
    platform_request_id_state: requestIdState,
    ...(requestIdState === "valid" && { platform_request_id: requestId }),
    ...build,
    attempt_denominator_kind: denominatorKind,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Opaque account IDs (WorkOS user_...). Excludes URLs, emails and whitespace.
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TRANSPORT_FORMATS: [string, (value: unknown) => boolean][] = [
  ["$session_id", (value) => typeof value === "string" && UUID.test(value)],
  ["$window_id", (value) => typeof value === "string" && UUID.test(value)],
  [
    "$lib",
    (value) =>
      typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value),
  ],
  [
    "$lib_version",
    (value) =>
      typeof value === "string" &&
      /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,32})?$/.test(value),
  ],
  ["$is_identified", (value) => typeof value === "boolean"],
  ["$process_person_profile", (value) => typeof value === "boolean"],
];

export type AgentStartDiagnosticExpectation = {
  /** The current permitted, identified and committed analytics owner, or null. */
  owner: string | null;
  /** The configured PostHog project key the SDK attaches as `token`. */
  token: string | undefined;
};

/**
 * Apply in before_send after SDK enrichment. The target event is rebuilt from
 * validated own data properties only and must belong to the current committed
 * analytics owner; anything unreadable or invalid is dropped. `resolveExpected`
 * runs only for the target event. Other events are returned unchanged.
 */
export function sanitizeAgentStartHttp413DiagnosticEvent<T extends object>(
  event: T | null,
  resolveExpected: () => AgentStartDiagnosticExpectation,
): T | null {
  if (!event) return event;
  try {
    const marker = readOwnData(event, "event");
    if (!marker) return null;
    if (marker.value !== AGENT_START_HTTP413_DIAGNOSTIC_EVENT) return event;

    const { owner, token } = resolveExpected();
    if (typeof owner !== "string" || !OPAQUE_ID.test(owner)) return null;
    const properties = readOwnData(event, "properties")?.value;
    if (
      typeof properties !== "object" ||
      properties === null ||
      Array.isArray(properties)
    )
      return null;
    const read = (key: string) => readOwnData(properties, key)?.value;
    // A queued event must not be exported under a different current owner.
    if (read("distinct_id") !== owner) return null;
    const schema = projectAgentStartHttp413Diagnostic(read);
    if (!schema) return null;

    const transport: Record<string, unknown> = { distinct_id: owner };
    const eventToken = read("token");
    if (typeof token === "string" && token !== "" && eventToken === token) {
      transport.token = token;
    }
    for (const [key, isValid] of TRANSPORT_FORMATS) {
      const value = read(key);
      if (isValid(value)) transport[key] = value;
    }

    const uuid = readOwnData(event, "uuid")?.value;
    const timestamp = readOwnData(event, "timestamp")?.value;
    let timestampMs: number | undefined;
    if (timestamp !== undefined) {
      try {
        // Accept only a real Date; ignore its own properties, toJSON or proxies.
        timestampMs = Date.prototype.getTime.call(timestamp);
      } catch {
        timestampMs = undefined;
      }
    }
    return {
      ...(typeof uuid === "string" && UUID.test(uuid) && { uuid }),
      event: AGENT_START_HTTP413_DIAGNOSTIC_EVENT,
      properties: { ...transport, ...schema },
      ...(timestampMs !== undefined &&
        Number.isFinite(timestampMs) && { timestamp: new Date(timestampMs) }),
    } as unknown as T;
  } catch {
    return null;
  }
}
