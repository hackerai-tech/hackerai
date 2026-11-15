import {
  readClosedConvexAuthProviderState,
  readClosedConvexAuthTokenDecision,
} from "@/lib/auth/convex-auth-diagnostics";

export const FILE_ACTION_AUTH_DIAGNOSTIC_EVENT = "file_action_auth_diagnostic";
export const FILE_ACTION_AUTH_DIAGNOSTIC_VERSION = 1;

/** The evidenced single-file URL callers, and the upload reservation. */
export type FileActionCaller =
  | "inline_image"
  | "file_preview"
  | "computer_sidebar"
  | "attachment_download"
  | "upload";
export type FileActionOperation =
  "getFileUrlAction" | "generateS3UploadUrlAction";

export const FILE_ACTION_OPERATION: Readonly<
  Record<FileActionCaller, FileActionOperation>
> = {
  inline_image: "getFileUrlAction",
  file_preview: "getFileUrlAction",
  computer_sidebar: "getFileUrlAction",
  attachment_download: "getFileUrlAction",
  upload: "generateS3UploadUrlAction",
};

/**
 * "unauthenticated_message": the backend guard's own message (unredacted
 * deployments). "redacted_server_error": production redacts uncaught errors,
 * so the client cannot tell the guard from other uncaught failures; only the
 * request ID joins it to the backend's guard record.
 */
export type FileActionFailureClass =
  "unauthenticated_message" | "redacted_server_error";

/** Convex's committed client auth state, distinct from the AuthKit provider. */
export type ConvexClientAuthState =
  "loading" | "authenticated" | "unauthenticated" | "unavailable";

export type FileActionInputRelation =
  "first" | "same" | "different" | "unavailable";

const CALLERS: readonly string[] = Object.keys(FILE_ACTION_OPERATION);
const FAILURE_CLASSES: readonly string[] = [
  "unauthenticated_message",
  "redacted_server_error",
];
const CONVEX_CLIENT_AUTH_STATES: readonly string[] = [
  "loading",
  "authenticated",
  "unauthenticated",
  "unavailable",
];
const INPUT_RELATIONS: readonly string[] = [
  "first",
  "same",
  "different",
  "unavailable",
];
const TOKEN_ATTEMPTS: readonly string[] = ["same", "changed", "unavailable"];
const TOKEN_FIELDS = ["mode", "outcome", "result", "age", "context"] as const;

const REQUEST_ID = /^[a-f0-9]{16}$/;
const BUILD_COMMIT = /^[a-f0-9]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Opaque account IDs (WorkOS user_...). Excludes URLs, emails and whitespace.
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_CLASSIFIED_MESSAGE_LENGTH = 2_048;

// The Convex browser SDK's action failure prefix. Anchored, so text elsewhere
// in a message (or a different function) can never match.
const ACTION_FAILURE_PREFIX =
  /^\[CONVEX A\(s3Actions:(getFileUrlAction|generateS3UploadUrlAction)\)\] \[Request ID: ([a-f0-9]{16})\] Server Error/;
const REDACTED_REMAINDER = /^(?:\n {2}Called by client)?$/;
const GUARD_MESSAGES: Readonly<Record<FileActionOperation, string>> = {
  getFileUrlAction:
    "\nUncaught Error: Unauthenticated: User must be logged in to access files",
  generateS3UploadUrlAction:
    "\nUncaught Error: Unauthenticated: User must be logged in to upload files",
};

/** Read an own data property without invoking accessors. Proxy traps may throw. */
function readOwnData(target: unknown, key: string): { value: unknown } | null {
  if (typeof target !== "object" || target === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && "value" in descriptor
    ? { value: descriptor.value }
    : null;
}

/**
 * Classify only this operation's exact known guard or redacted failure; never
 * retain the message. ConvexErrors (own `data`) are application outcomes such
 * as plan or storage limits, not the auth guard.
 */
export function classifyFileActionAuthFailure(
  error: unknown,
  operation: FileActionOperation,
): {
  failure_class: FileActionFailureClass;
  convex_request_id: string;
} | null {
  try {
    if (Object.getOwnPropertyDescriptor(Object(error), "data")) return null;
    // No getters, toString, stack or cause.
    const message = readOwnData(error, "message")?.value;
    if (
      typeof message !== "string" ||
      message.length > MAX_CLASSIFIED_MESSAGE_LENGTH
    )
      return null;
    const prefix = ACTION_FAILURE_PREFIX.exec(message);
    if (!prefix || prefix[1] !== operation) return null;
    const remainder = message.slice(prefix[0].length);
    const guard = GUARD_MESSAGES[operation];
    const failureClass: FileActionFailureClass | null = REDACTED_REMAINDER.test(
      remainder,
    )
      ? "redacted_server_error"
      : remainder.startsWith(guard) &&
          (remainder.length === guard.length ||
            remainder[guard.length] === "\n")
        ? "unauthenticated_message"
        : null;
    return failureClass
      ? { failure_class: failureClass, convex_request_id: prefix[2] }
      : null;
  } catch {
    // Proxies and exotic objects fail closed without affecting the caller.
    return null;
  }
}

/** Only exact booleans describe a state; anything else is unavailable. */
export function readClosedConvexClientAuthState(
  read: () => unknown,
): ConvexClientAuthState {
  try {
    const value = read();
    const isLoading = readOwnData(value, "isLoading")?.value;
    const isAuthenticated = readOwnData(value, "isAuthenticated")?.value;
    if (typeof isLoading !== "boolean" || typeof isAuthenticated !== "boolean")
      return "unavailable";
    if (isLoading) return "loading";
    return isAuthenticated ? "authenticated" : "unauthenticated";
  } catch {
    return "unavailable";
  }
}

function isKnown(known: readonly string[], value: unknown): value is string {
  return typeof value === "string" && known.includes(value);
}

function isProviderState(value: unknown): boolean {
  return (
    typeof value === "string" &&
    readClosedConvexAuthProviderState(() => value) === value
  );
}

/** All five fields unavailable, or all five accepted by the shared closed reader. */
function projectTokenDecision(
  read: (key: string) => unknown,
  prefix: "request_token_" | "token_",
): Record<string, string> | null {
  const values = TOKEN_FIELDS.map((field) => read(`${prefix}${field}`));
  if (values.every((value) => value === "unavailable")) {
    return Object.fromEntries(
      TOKEN_FIELDS.map((field) => [`${prefix}${field}`, "unavailable"]),
    );
  }
  const closed = readClosedConvexAuthTokenDecision(() =>
    Object.fromEntries(TOKEN_FIELDS.map((field, i) => [field, values[i]])),
  );
  if (TOKEN_FIELDS.some((field, i) => closed[field] !== values[i])) return null;
  return Object.fromEntries(
    TOKEN_FIELDS.map((field) => [`${prefix}${field}`, closed[field]]),
  );
}

/**
 * The single schema for this event. Rebuilds only known finite fields; any
 * missing, malformed or inconsistent field rejects the whole diagnostic.
 */
export function projectFileActionAuthDiagnostic(
  read: (key: string) => unknown,
): Record<string, unknown> | null {
  const version = read("file_action_auth_diagnostic_version");
  const caller = read("caller");
  const operation = read("operation");
  const failureClass = read("failure_class");
  const requestId = read("convex_request_id");
  const requestAuth = read("request_convex_auth_state");
  const auth = read("convex_auth_state");
  const requestProvider = read("request_provider_state");
  const provider = read("provider_state");
  const tokenAttempt = read("token_attempt");
  const inputRelation = read("input_relation");
  const scopeId = read("observer_scope_id");
  const buildCommit = read("hackerai_frontend_build_commit");

  if (version !== FILE_ACTION_AUTH_DIAGNOSTIC_VERSION) return null;
  if (!isKnown(CALLERS, caller)) return null;
  const expectedOperation = FILE_ACTION_OPERATION[caller as FileActionCaller];
  if (operation !== expectedOperation) return null;
  if (!isKnown(FAILURE_CLASSES, failureClass)) return null;
  if (
    requestId !== undefined &&
    (typeof requestId !== "string" || !REQUEST_ID.test(requestId))
  )
    return null;
  if (
    !isKnown(CONVEX_CLIENT_AUTH_STATES, requestAuth) ||
    !isKnown(CONVEX_CLIENT_AUTH_STATES, auth)
  )
    return null;
  if (!isProviderState(requestProvider) || !isProviderState(provider))
    return null;
  const requestToken = projectTokenDecision(read, "request_token_");
  const token = projectTokenDecision(read, "token_");
  if (!requestToken || !token) return null;
  if (!isKnown(TOKEN_ATTEMPTS, tokenAttempt)) return null;
  // Uploads never compare inputs.
  if (
    !isKnown(INPUT_RELATIONS, inputRelation) ||
    (caller === "upload" && inputRelation !== "unavailable")
  )
    return null;
  if (
    scopeId !== undefined &&
    (typeof scopeId !== "string" || !UUID.test(scopeId))
  )
    return null;
  if (
    buildCommit !== undefined &&
    (typeof buildCommit !== "string" || !BUILD_COMMIT.test(buildCommit))
  )
    return null;

  return {
    file_action_auth_diagnostic_version: version,
    caller,
    operation,
    failure_class: failureClass,
    ...(requestId !== undefined && { convex_request_id: requestId }),
    request_convex_auth_state: requestAuth,
    convex_auth_state: auth,
    request_provider_state: requestProvider,
    provider_state: provider,
    ...requestToken,
    ...token,
    token_attempt: tokenAttempt,
    input_relation: inputRelation,
    ...(scopeId !== undefined && { observer_scope_id: scopeId }),
    ...(buildCommit !== undefined && {
      hackerai_frontend_build_commit: buildCommit,
    }),
  };
}

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

export type FileActionAuthDiagnosticExpectation = {
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
export function sanitizeFileActionAuthDiagnosticEvent<T extends object>(
  event: T | null,
  resolveExpected: () => FileActionAuthDiagnosticExpectation,
): T | null {
  if (!event) return event;
  try {
    const marker = readOwnData(event, "event");
    if (!marker) return null;
    if (marker.value !== FILE_ACTION_AUTH_DIAGNOSTIC_EVENT) return event;

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
    const schema = projectFileActionAuthDiagnostic(read);
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
      event: FILE_ACTION_AUTH_DIAGNOSTIC_EVENT,
      properties: { ...transport, ...schema },
      ...(timestampMs !== undefined &&
        Number.isFinite(timestampMs) && { timestamp: new Date(timestampMs) }),
    } as unknown as T;
  } catch {
    return null;
  }
}
