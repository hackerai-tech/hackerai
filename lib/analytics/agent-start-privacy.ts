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

export const AGENT_PARTIAL_SAVE_HTTP413_DIAGNOSTIC_EVENT =
  "agent_partial_save_http413_diagnostic";
export const AGENT_PARTIAL_SAVE_HTTP413_DIAGNOSTIC_VERSION = 1;
/** Coarse UTF-8 size of the exact partial-save body; never a byte count. */
export const AGENT_PARTIAL_SAVE_BODY_BUCKETS = [
  "lte_4_mib",
  "gt_4_lte_4_5_mib",
  "gt_4_5_lte_8_mib",
  "gt_8_mib",
  "unknown",
] as const;
export type AgentPartialSaveBodyBucket =
  (typeof AGENT_PARTIAL_SAVE_BODY_BUCKETS)[number];

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
const PARTIAL_SAVE_BODY_BUCKETS = new Set<string>(
  AGENT_PARTIAL_SAVE_BODY_BUCKETS,
);

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

type Read = (key: string) => unknown;
type Projection = Record<string, unknown>;

/** The optional `x-vercel-id` correlation, copied only in its validated form. */
function projectPlatformRequestId(read: Read): Projection | null {
  const state = read("platform_request_id_state");
  const requestId = read("platform_request_id");
  if (!isClosed(REQUEST_ID_STATES, state)) return null;
  if (state === "valid") {
    return isPlatformRequestId(requestId)
      ? { platform_request_id_state: state, platform_request_id: requestId }
      : null;
  }
  return requestId === undefined ? { platform_request_id_state: state } : null;
}

function projectBuild(read: Read): Projection | null {
  const buildState = read("build_state");
  const buildCommit = read("hackerai_frontend_build_commit");
  // Native capture overwrites an invalid build commit with null.
  return buildState === "measured" &&
    typeof buildCommit === "string" &&
    /^[0-9a-f]{40}$/.test(buildCommit)
    ? { build_state: "measured", hackerai_frontend_build_commit: buildCommit }
    : buildState === "unavailable" &&
        (buildCommit === undefined || buildCommit === null)
      ? { build_state: "unavailable" }
      : null;
}

/**
 * The Agent start schema. Rebuilds only known finite fields; any missing,
 * malformed or inconsistent field rejects the whole diagnostic.
 */
export function projectAgentStartHttp413Diagnostic(
  read: Read,
): Projection | null {
  const version = read("agent_start_http413_diagnostic_version");
  const status = read("http_status");
  const bodyState = read("request_body_state");
  const bodyBytes = read("request_body_utf8_bytes");
  const appMarker = read("app_rejection_marker_state");
  const vercelError = read("vercel_error_state");
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
  const requestId = projectPlatformRequestId(read);
  if (!requestId) return null;
  const build = projectBuild(read);
  if (!build) return null;
  if (denominatorKind !== "unmeasured") return null;

  return {
    agent_start_http413_diagnostic_version: version,
    http_status: status,
    request_body_state: bodyState,
    ...(bodyState === "measured" && { request_body_utf8_bytes: bodyBytes }),
    app_rejection_marker_state: appMarker,
    vercel_error_state: vercelError,
    ...requestId,
    ...build,
    attempt_denominator_kind: denominatorKind,
  };
}

/**
 * The Agent partial-save schema: a coarse body-size bucket, never a byte
 * count. Any missing, malformed or inconsistent field rejects the diagnostic.
 */
export function projectAgentPartialSaveHttp413Diagnostic(
  read: Read,
): Projection | null {
  const version = read("agent_partial_save_http413_diagnostic_version");
  const status = read("http_status");
  const bodyBucket = read("request_body_utf8_bucket");
  const vercelError = read("vercel_error_state");

  if (version !== AGENT_PARTIAL_SAVE_HTTP413_DIAGNOSTIC_VERSION) return null;
  if (status !== 413) return null;
  if (!isClosed(PARTIAL_SAVE_BODY_BUCKETS, bodyBucket)) return null;
  if (!isClosed(MARKER_STATES, vercelError)) return null;
  const requestId = projectPlatformRequestId(read);
  if (!requestId) return null;
  const build = projectBuild(read);
  if (!build) return null;

  return {
    agent_partial_save_http413_diagnostic_version: version,
    http_status: status,
    request_body_utf8_bucket: bodyBucket,
    vercel_error_state: vercelError,
    ...requestId,
    ...build,
  };
}

const AGENT_HTTP413_PROJECTIONS = new Map<
  string,
  (read: Read) => Projection | null
>([
  [AGENT_START_HTTP413_DIAGNOSTIC_EVENT, projectAgentStartHttp413Diagnostic],
  [
    AGENT_PARTIAL_SAVE_HTTP413_DIAGNOSTIC_EVENT,
    projectAgentPartialSaveHttp413Diagnostic,
  ],
]);

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
 * Apply in before_send after SDK enrichment. An Agent start or partial-save
 * HTTP 413 diagnostic is rebuilt from its own schema's validated own data
 * properties only and must belong to the current committed analytics owner;
 * anything unreadable or invalid is dropped. `resolveExpected` runs only for
 * these events. Other events are returned unchanged.
 */
export function sanitizeAgentHttp413DiagnosticEvent<T extends object>(
  event: T | null,
  resolveExpected: () => AgentStartDiagnosticExpectation,
): T | null {
  if (!event) return event;
  try {
    const marker = readOwnData(event, "event");
    if (!marker) return null;
    const eventName = marker.value;
    const project =
      typeof eventName === "string"
        ? AGENT_HTTP413_PROJECTIONS.get(eventName)
        : undefined;
    if (!project) return event;

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
    const schema = project(read);
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
      event: eventName,
      properties: { ...transport, ...schema },
      ...(timestampMs !== undefined &&
        Number.isFinite(timestampMs) && { timestamp: new Date(timestampMs) }),
    } as unknown as T;
  } catch {
    return null;
  }
}
