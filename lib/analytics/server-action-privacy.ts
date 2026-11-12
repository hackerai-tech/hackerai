export const SERVER_ACTION_CLIENT_CONTEXT_EVENT =
  "server_action_client_context";
export const SERVER_ACTION_CLIENT_DIAGNOSTIC_VERSION = 1;
/** Local prefix counters stop being reported beyond this many settlements. */
export const SERVER_ACTION_ATTEMPT_COUNT_LIMIT = 10_000;

export type ServerActionLocalCaller =
  "analytics_consent" | "billing_renewal_recovery";
export type ServerActionGlobalCaller =
  "global_error" | "global_unhandled_rejection";
export type ServerActionGlobalDecision =
  "reload_requested" | "cooldown_skipped";
export type ServerActionUnavailableMatch = {
  matched_pattern:
    "next_unrecognized_action_message" | "server_action_missing_message";
  reference_shape: "hex42" | "other_or_unavailable";
};

const LOCAL_CALLERS = new Set([
  "analytics_consent",
  "billing_renewal_recovery",
]);
const GLOBAL_CALLERS = new Set(["global_error", "global_unhandled_rejection"]);
const GLOBAL_DECISIONS = new Set(["reload_requested", "cooldown_skipped"]);
const MATCHED_PATTERNS = new Set([
  "next_unrecognized_action_message",
  "server_action_missing_message",
]);
const REFERENCE_SHAPES = new Set(["hex42", "other_or_unavailable"]);
const MAX_CLASSIFIED_MESSAGE_LENGTH = 2_048;

// The Next client reducer's UnrecognizedActionError and the server's missing
// action error. The broader global recovery matcher is intentionally separate.
const UNRECOGNIZED_ACTION_MESSAGE =
  /Server Action "([^"\s]{0,128})" was not found on the server/;
const MISSING_ACTION_MESSAGE =
  /Failed to find Server Action(?: "([^"\s]{0,128})")?\. This request might be from an older or newer deployment/;

/** Read an own data property without invoking accessors. Proxy traps may throw. */
function readOwnData(target: unknown, key: string): { value: unknown } | null {
  if (typeof target !== "object" || target === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && "value" in descriptor
    ? { value: descriptor.value }
    : null;
}

function readBoundedMessage(value: unknown): string | null {
  if (typeof value === "string") {
    return value.length <= MAX_CLASSIFIED_MESSAGE_LENGTH ? value : null;
  }
  // No getters, toString, stack or cause.
  const message = readOwnData(value, "message")?.value;
  return typeof message === "string" &&
    message.length <= MAX_CLASSIFIED_MESSAGE_LENGTH
    ? message
    : null;
}

/** Classify only the two known unavailable-action messages; never retain them. */
export function classifyServerActionUnavailable(
  value: unknown,
): ServerActionUnavailableMatch | null {
  try {
    const message = readBoundedMessage(value);
    if (message === null) return null;
    const unrecognized = UNRECOGNIZED_ACTION_MESSAGE.exec(message);
    const missing = unrecognized ? null : MISSING_ACTION_MESSAGE.exec(message);
    const match = unrecognized ?? missing;
    if (!match) return null;
    return {
      matched_pattern: unrecognized
        ? "next_unrecognized_action_message"
        : "server_action_missing_message",
      // Shape only. The reference is not an ID, fingerprint or legitimacy signal.
      reference_shape: /^[0-9a-f]{42}$/i.test(match[1] ?? "")
        ? "hex42"
        : "other_or_unavailable",
    };
  } catch {
    // Proxies and exotic objects fail closed without affecting the caller.
    return null;
  }
}

/** The compiled 40-hex frontend commit, kept distinct from 42-hex action references. */
export function getServerActionBuildContext():
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

function isAttemptCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= SERVER_ACTION_ATTEMPT_COUNT_LIMIT
  );
}

function projectSchema(
  read: (key: string) => unknown,
): Record<string, unknown> | null {
  const version = read("server_action_client_diagnostic_version");
  const caller = read("caller");
  const matchedPattern = read("matched_pattern");
  const referenceShape = read("reference_shape");
  const decision = read("recovery_decision");
  const buildState = read("build_state");
  const buildCommit = read("hackerai_frontend_build_commit");
  const denominatorKind = read("attempt_denominator_kind");
  const settledCount = read("caller_settled_attempt_count");
  const recognizedCount = read("caller_recognized_rejection_count");
  if (version !== SERVER_ACTION_CLIENT_DIAGNOSTIC_VERSION) return null;
  if (
    typeof matchedPattern !== "string" ||
    !MATCHED_PATTERNS.has(matchedPattern) ||
    typeof referenceShape !== "string" ||
    !REFERENCE_SHAPES.has(referenceShape)
  )
    return null;

  const local = typeof caller === "string" && LOCAL_CALLERS.has(caller);
  const global = typeof caller === "string" && GLOBAL_CALLERS.has(caller);
  if (local ? decision !== "locally_handled_no_reload" : !global) return null;
  if (
    global &&
    (typeof decision !== "string" || !GLOBAL_DECISIONS.has(decision))
  )
    return null;

  const build =
    buildState === "measured" &&
    typeof buildCommit === "string" &&
    /^[0-9a-f]{40}$/.test(buildCommit)
      ? { build_state: "measured", hackerai_frontend_build_commit: buildCommit }
      : buildState === "unavailable" && buildCommit === undefined
        ? { build_state: "unavailable" }
        : null;
  if (!build) return null;

  let denominator: Record<string, unknown>;
  if (denominatorKind === "unmeasured") {
    denominator = { attempt_denominator_kind: "unmeasured" };
  } else if (
    denominatorKind === "caller_settled_prefix" &&
    local &&
    isAttemptCount(settledCount) &&
    isAttemptCount(recognizedCount) &&
    recognizedCount <= settledCount
  ) {
    denominator = {
      attempt_denominator_kind: "caller_settled_prefix",
      caller_settled_attempt_count: settledCount,
      caller_recognized_rejection_count: recognizedCount,
    };
  } else {
    return null;
  }

  return {
    server_action_client_diagnostic_version: version,
    caller,
    matched_pattern: matchedPattern,
    reference_shape: referenceShape,
    recovery_decision: decision,
    ...build,
    ...denominator,
  };
}

export type ServerActionContextExpectation = {
  /** The current permitted and identified analytics owner, or null. */
  owner: string | null;
  /** The configured PostHog project key the SDK attaches as `token`. */
  token: string | undefined;
};

/**
 * Apply after SDK enrichment. The target event is rebuilt from validated own
 * data properties only and must belong to the current analytics owner; any
 * unreadable or invalid target is dropped. `resolveExpected` runs only for the
 * target event. Other events are returned unchanged.
 */
export function sanitizeServerActionClientContextEvent<T extends object>(
  event: T | null,
  resolveExpected: () => ServerActionContextExpectation,
): T | null {
  if (!event) return event;
  try {
    const marker = readOwnData(event, "event");
    if (!marker) return null;
    if (marker.value !== SERVER_ACTION_CLIENT_CONTEXT_EVENT) return event;

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
    const schema = projectSchema(read);
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
      event: SERVER_ACTION_CLIENT_CONTEXT_EVENT,
      properties: { ...transport, ...schema },
      ...(timestampMs !== undefined &&
        Number.isFinite(timestampMs) && { timestamp: new Date(timestampMs) }),
    } as unknown as T;
  } catch {
    return null;
  }
}
