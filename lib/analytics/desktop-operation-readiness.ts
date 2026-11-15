import {
  captureAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
  getPermittedAnalyticsUserId,
} from "@/lib/analytics/client";

/**
 * A Desktop operation-channel readiness step rejected on this client. The phase
 * says which client-side step failed; it does not establish broker delivery,
 * non-execution or customer recovery. Captured once per failed operation on the
 * existing relay error event, outside the shared relay summary buffer, which
 * can outlive an account switch.
 */
export const DESKTOP_RELAY_ERROR_EVENT = "desktop_bridge_relay_error";
export const DESKTOP_OPERATION_READINESS_VERSION = 1;

const PHASES = new Set(["subscription_ready", "readiness_publish"]);
const KINDS = new Set(["command", "file", "pty"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Opaque account IDs (WorkOS user_...). Excludes URLs, emails and whitespace.
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BUILD_COMMIT = /^[0-9a-f]{40}$/;
const ENVELOPE = {
  state: "error",
  clientSurface: "desktop_bridge",
  source: "operation_channel",
  errorType: "operation_readiness",
} as const;

/** Read an own data property without invoking accessors. Proxy traps may throw. */
function readOwnData(target: unknown, key: string): { value: unknown } | null {
  if (typeof target !== "object" || target === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && "value" in descriptor
    ? { value: descriptor.value }
    : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && UUID.test(value);
}

function readBuildContext():
  | { build_state: "measured"; hackerai_frontend_build_commit: string }
  | { build_state: "unavailable" } {
  const commit = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
  return typeof commit === "string" && /^[0-9a-f]{40}$/i.test(commit)
    ? {
        build_state: "measured",
        hackerai_frontend_build_commit: commit.toLowerCase(),
      }
    : { build_state: "unavailable" };
}

/**
 * The single schema for this diagnostic. Rebuilds only the finite tuple; any
 * missing or malformed field rejects the whole diagnostic.
 */
export function projectDesktopOperationReadiness(
  read: (key: string) => unknown,
): Record<string, unknown> | null {
  for (const [key, expected] of Object.entries(ENVELOPE)) {
    if (read(key) !== expected) return null;
  }
  const version = read("operation_readiness_version");
  const phase = read("operation_readiness_phase");
  const kind = read("operation_readiness_kind");
  const operationId = read("operation_readiness_operation_id");
  const connectionId = read("connectionId");
  const buildState = read("build_state");
  const buildCommit = read("hackerai_frontend_build_commit");

  if (version !== DESKTOP_OPERATION_READINESS_VERSION) return null;
  if (typeof phase !== "string" || !PHASES.has(phase)) return null;
  if (typeof kind !== "string" || !KINDS.has(kind)) return null;
  if (!isUuid(operationId) || !isUuid(connectionId)) return null;
  // Native capture overwrites an invalid build commit with null.
  const build =
    buildState === "measured" &&
    typeof buildCommit === "string" &&
    BUILD_COMMIT.test(buildCommit)
      ? { build_state: "measured", hackerai_frontend_build_commit: buildCommit }
      : buildState === "unavailable" &&
          (buildCommit === undefined || buildCommit === null)
        ? { build_state: "unavailable" }
        : null;
  if (!build) return null;

  return {
    ...ENVELOPE,
    connectionId,
    operation_readiness_version: version,
    operation_readiness_phase: phase,
    operation_readiness_kind: kind,
    operation_readiness_operation_id: operationId,
    ...build,
  };
}

/**
 * Capture one failed readiness step for the bridge's captured owner. The caller
 * fences the live bridge, router and connection; this rejects any analytics
 * owner other than that captured account and any value outside the schema.
 */
export function captureDesktopOperationReadinessFailure(input: {
  owner: string;
  connectionId: string;
  phase: unknown;
  kind: unknown;
  operationId: unknown;
}): boolean {
  try {
    const { owner } = input;
    if (
      typeof owner !== "string" ||
      !OPAQUE_ID.test(owner) ||
      getPermittedAnalyticsUserId() !== owner ||
      getIdentifiedAnalyticsUserId() !== owner
    )
      return false;
    const candidate: Record<string, unknown> = {
      ...ENVELOPE,
      connectionId: input.connectionId,
      operation_readiness_version: DESKTOP_OPERATION_READINESS_VERSION,
      operation_readiness_phase: input.phase,
      operation_readiness_kind: input.kind,
      operation_readiness_operation_id: input.operationId,
      ...readBuildContext(),
    };
    const properties = projectDesktopOperationReadiness((key) =>
      Object.hasOwn(candidate, key) ? candidate[key] : undefined,
    );
    if (!properties) return false;
    return captureAuthenticatedEvent(DESKTOP_RELAY_ERROR_EVENT, properties);
  } catch {
    return false;
  }
}

const TRANSPORT_FORMATS: [string, (value: unknown) => boolean][] = [
  ["$session_id", isUuid],
  ["$window_id", isUuid],
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

export type DesktopOperationReadinessExpectation = {
  /** The current permitted, identified and committed analytics owner, or null. */
  owner: string | null;
  /** The configured PostHog project key the SDK attaches as `token`. */
  token: string | undefined;
};

/**
 * Apply in before_send after SDK enrichment. A relay error carrying this
 * diagnostic is rebuilt from validated own data properties only and must
 * belong to the current committed analytics owner; anything unreadable or
 * invalid is dropped. Other events, including other relay errors, are
 * returned unchanged. `resolveExpected` runs only for the target event.
 */
export function sanitizeDesktopOperationReadinessEvent<T extends object>(
  event: T | null,
  resolveExpected: () => DesktopOperationReadinessExpectation,
): T | null {
  if (!event) return event;
  try {
    const marker = readOwnData(event, "event");
    if (!marker) return null;
    if (marker.value !== DESKTOP_RELAY_ERROR_EVENT) return event;
    const descriptor = Object.getOwnPropertyDescriptor(event, "properties");
    // An accessor could serialize different contents than it is checked with.
    if (descriptor && !("value" in descriptor)) return null;
    const properties: unknown = descriptor?.value;
    if (typeof properties !== "object" || properties === null) return event;
    // Any trace of the diagnostic, including an accessor or inherited field,
    // makes this the target; an unrelated relay error carries none of these.
    if (
      !("operation_readiness_version" in properties) &&
      readOwnData(properties, "errorType")?.value !== ENVELOPE.errorType &&
      readOwnData(properties, "source")?.value !== ENVELOPE.source
    )
      return event;

    const { owner, token } = resolveExpected();
    if (typeof owner !== "string" || !OPAQUE_ID.test(owner)) return null;
    const read = (key: string) => readOwnData(properties, key)?.value;
    // A queued event must not be exported under a different current owner.
    if (read("distinct_id") !== owner) return null;
    const schema = projectDesktopOperationReadiness(read);
    if (!schema) return null;

    const transport: Record<string, unknown> = { distinct_id: owner };
    if (typeof token === "string" && token !== "" && read("token") === token) {
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
      ...(isUuid(uuid) && { uuid }),
      event: DESKTOP_RELAY_ERROR_EVENT,
      properties: { ...transport, ...schema },
      ...(timestampMs !== undefined &&
        Number.isFinite(timestampMs) && { timestamp: new Date(timestampMs) }),
    } as unknown as T;
  } catch {
    return null;
  }
}
