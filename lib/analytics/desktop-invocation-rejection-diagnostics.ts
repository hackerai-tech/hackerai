/** One acknowledged stream command's rejected native invocation, as a closed
 * class of the fixed message the native app rejected it with, and the command
 * set the bridge selected for it. Never the message itself.
 *
 * A reason classifies the source message, not a physical stage, a cause or the
 * installed binary: the same message can arise more than one way. Every
 * message below has identical text in the desktop-v0.0.73 and desktop-v0.0.74
 * sources and in the current source; other releases were not inspected.
 * Anything else, including a changed message, a Tauri runtime error or a
 * frontend error, is `unknown`, refined only by a closed class below.
 */

const REASONS = [
  "authorization_id_invalid",
  "authorization_precondition",
  "authorization_unavailable",
  "authorization_not_approved",
  "authorization_response_invalid",
  "operation_rejected",
  "execution_admission",
  "spawn_failed",
  "unknown",
] as const;

export type DesktopInvocationRejectionReason = (typeof REASONS)[number];

/** The native command sets the bridge selects, never the file loopback, or
 * `not_selected` when the invocation failed before any was selected. */
const ADAPTERS = [
  "authorized_native",
  "compatibility_native",
  "published_legacy_native",
  "not_selected",
] as const;

export type DesktopInvocationRejectionAdapter = (typeof ADAPTERS)[number];

/** Only the authorized command emits these; a legacy command never can. */
const AUTHORIZED_ONLY: ReadonlySet<DesktopInvocationRejectionReason> = new Set([
  "authorization_id_invalid",
  "authorization_precondition",
  "authorization_unavailable",
  "authorization_not_approved",
  "authorization_response_invalid",
  "operation_rejected",
]);

/** A closed class of the fixed `execution_admission` message, refining that
 * reason only. Like the reason, it names the message template, never the
 * physical update, stdin, lock or duplicate-command state behind it. */
const ADMISSION_REASONS = [
  "update_state_unavailable",
  "update_installing",
  "stdin_size_limit",
  "stdin_encoding_invalid",
  "command_state_lock_poisoned",
  "command_already_running",
] as const;

export type DesktopInvocationAdmissionReason =
  (typeof ADMISSION_REASONS)[number];

// execute_stream_command admission: update_safety.rs UpdateGate::operation,
// command_stdin.rs decode and lib.rs spawn_stream_command.
const ADMISSION_MESSAGES: ReadonlyMap<
  string,
  DesktopInvocationAdmissionReason
> = new Map([
  ["Desktop update state unavailable", "update_state_unavailable"],
  [
    "Desktop is installing an update. Reopen the app before retrying.",
    "update_installing",
  ],
  ["Command stdin exceeds limit", "stdin_size_limit"],
  ["Invalid command stdin encoding", "stdin_encoding_invalid"],
  ["stream command state lock poisoned", "command_state_lock_poisoned"],
  ["Command is already running", "command_already_running"],
]);

const MESSAGE_REASONS: ReadonlyMap<string, DesktopInvocationRejectionReason> =
  new Map<string, DesktopInvocationRejectionReason>([
    // lib.rs redeem_authorized_message, before its approval request is sent.
    ["Invalid Desktop operation authorization", "authorization_id_invalid"],
    ["Invalid Desktop operation", "authorization_precondition"],
    ["Desktop origin is unavailable", "authorization_precondition"],
    [
      "Desktop origin is not allowed for native authorization",
      "authorization_precondition",
    ],
    ["Desktop authorization client unavailable", "authorization_precondition"],
    // The approval request's own error messages.
    [
      "Desktop operation authorization unavailable",
      "authorization_unavailable",
    ],
    ["Desktop operation was not authorized", "authorization_not_approved"],
    [
      "Invalid Desktop authorization response",
      "authorization_response_invalid",
    ],
    // lib.rs authorized_operation_type and the approved command's shape.
    ["Desktop operation type is missing", "operation_rejected"],
    ["Desktop operation type is not allowed here", "operation_rejected"],
    ["Invalid authorized command", "operation_rejected"],
    ...Array.from(
      ADMISSION_MESSAGES.keys(),
      (message) => [message, "execution_admission"] as const,
    ),
  ]);

// Native stream spawn rejection; the OS error text after it is never
// interpreted. Only its final suffix is compared, below.
const SPAWN_PREFIX = "Failed to spawn: ";
const MAX_MESSAGE_LENGTH = 1024;

/** Reviewed numeric codes a spawn failure's Rust io::Error Display can end
 * with, as ` (os error N)`. A code's meaning is platform-specific: the hint is
 * the parsed message suffix, never an IO kind or a physical cause. */
const SPAWN_OS_CODES = [2, 3, 5, 32, 87, 193, 206, 267, 740, 1260] as const;

const SPAWN_OS_CODE_HINTS = [
  ...SPAWN_OS_CODES.map((code) => `code_${code}` as const),
  // Any other bounded spawn message: a delivered hint naming no code.
  "unrecognized",
] as const;

export type DesktopInvocationSpawnOsCodeHint =
  (typeof SPAWN_OS_CODE_HINTS)[number];

const SPAWN_OS_CODE_SUFFIXES: ReadonlyMap<
  string,
  DesktopInvocationSpawnOsCodeHint
> = new Map(
  SPAWN_OS_CODES.map(
    (code) => [` (os error ${code})`, `code_${code}` as const] as const,
  ),
);

/** The reviewed code that exactly ends the OS text after the spawn prefix, or
 * `unrecognized`; literal comparisons only, so no other text or number is
 * ever returned. */
function spawnOsCodeHint(osText: string): DesktopInvocationSpawnOsCodeHint {
  for (const [suffix, hint] of SPAWN_OS_CODE_SUFFIXES)
    if (osText.endsWith(suffix)) return hint;
  return "unrecognized";
}

export interface DesktopInvocationRejectionDiagnostic {
  readonly desktop_invocation_rejection_version: 1;
  readonly desktop_invocation_rejection_reason: DesktopInvocationRejectionReason;
  readonly desktop_invocation_rejection_adapter: DesktopInvocationRejectionAdapter;
}

const PROPERTIES = [
  "desktop_invocation_rejection_version",
  "desktop_invocation_rejection_reason",
  "desktop_invocation_rejection_adapter",
] as const satisfies readonly (keyof DesktopInvocationRejectionDiagnostic)[];

export const DESKTOP_INVOCATION_REJECTION_PROPERTIES: ReadonlySet<string> =
  new Set(PROPERTIES);

/** A closed class of an `unknown` reason, refining that reason only. The
 * lifecycle classes name a fixed message template, never the physical page,
 * cleanup or process state behind it; the rest name only how the message was
 * readable, never its text. */
const UNKNOWN_CLASSES = [
  "lifecycle_page_replaced",
  "lifecycle_prior_cleanup_pending",
  "lifecycle_stop_unconfirmed",
  // A bounded message from a string or an Error's own data `message`.
  "other_string",
  "other_error_message",
  "message_over_limit",
  // Not a string, nor an Error with an own data string `message`.
  "message_unavailable",
] as const;

export type DesktopInvocationUnknownClass = (typeof UNKNOWN_CLASSES)[number];

// stream_lifecycle.rs admission denials, first in the source after
// desktop-v0.0.81. Exact equality only: a changed template is `other_*`.
const LIFECYCLE_MESSAGES: ReadonlyMap<string, DesktopInvocationUnknownClass> =
  new Map([
    [
      "Desktop page was replaced before this command started",
      "lifecycle_page_replaced",
    ],
    [
      "Desktop is still stopping commands from a previous page. Retry shortly.",
      "lifecycle_prior_cleanup_pending",
    ],
    [
      "Desktop could not confirm an earlier command stopped. New commands are blocked for this session. Close and reopen Desktop before running more commands.",
      "lifecycle_stop_unconfirmed",
    ],
  ]);

/** Tauri rejects with the native string. Otherwise only an Error's own data
 * `message` is read: never a getter, `toString` or other coercion. */
function rejectionMessage(
  error: unknown,
): { readonly text: string; readonly fromError: boolean } | null {
  if (typeof error === "string") return { text: error, fromError: false };
  try {
    if (!(error instanceof Error)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    return descriptor &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
      ? { text: descriptor.value, fromError: true }
      : null;
  } catch {
    return null;
  }
}

export interface NativeInvocationRejectionClass {
  readonly reason: DesktopInvocationRejectionReason;
  /** Set only for an `execution_admission` reason. */
  readonly admission: DesktopInvocationAdmissionReason | null;
  /** Set only for a `spawn_failed` reason. */
  readonly spawnOsCodeHint: DesktopInvocationSpawnOsCodeHint | null;
  /** Set only for an `unknown` reason. */
  readonly unknownClass: DesktopInvocationUnknownClass | null;
}

const unclassified = (
  unknownClass: DesktopInvocationUnknownClass,
): NativeInvocationRejectionClass => ({
  reason: "unknown",
  admission: null,
  spawnOsCodeHint: null,
  unknownClass,
});

/** Every class from one read of the message. Never throws; anything but a
 * listed message is `unknown`, refined only by its closed unknown class. */
export function classifyNativeInvocationRejectionMessage(
  error: unknown,
): NativeInvocationRejectionClass {
  const read = rejectionMessage(error);
  if (read === null) return unclassified("message_unavailable");
  const message = read.text;
  if (message.length > MAX_MESSAGE_LENGTH)
    return unclassified("message_over_limit");
  const reason =
    MESSAGE_REASONS.get(message) ??
    (message.startsWith(SPAWN_PREFIX) ? "spawn_failed" : "unknown");
  return {
    reason,
    admission: ADMISSION_MESSAGES.get(message) ?? null,
    spawnOsCodeHint:
      reason === "spawn_failed"
        ? spawnOsCodeHint(message.slice(SPAWN_PREFIX.length))
        : null,
    unknownClass:
      reason === "unknown"
        ? (LIFECYCLE_MESSAGES.get(message) ??
          (read.fromError ? "other_error_message" : "other_string"))
        : null,
  };
}

/** Never throws; anything but a listed message is `unknown`. */
export function classifyNativeInvocationRejection(
  error: unknown,
): DesktopInvocationRejectionReason {
  return classifyNativeInvocationRejectionMessage(error).reason;
}

/** The complete group, or null for an unlisted value or a reason the
 * selected command set can never emit. No native command set was invoked
 * without a selection, so `not_selected` is only ever `unknown`. */
export function desktopInvocationRejectionDiagnostic(
  reason: unknown,
  adapter: unknown,
): DesktopInvocationRejectionDiagnostic | null {
  const knownReason = REASONS.find((value) => value === reason);
  const knownAdapter = ADAPTERS.find((value) => value === adapter);
  if (!knownReason || !knownAdapter) return null;
  if (AUTHORIZED_ONLY.has(knownReason) && knownAdapter !== "authorized_native")
    return null;
  if (knownAdapter === "not_selected" && knownReason !== "unknown") return null;
  return Object.freeze({
    desktop_invocation_rejection_version: 1,
    desktop_invocation_rejection_reason: knownReason,
    desktop_invocation_rejection_adapter: knownAdapter,
  });
}

/** Read the complete group from any property bag's own data properties, or
 * nothing at all. A getter never runs; a throwing proxy reads as nothing. */
export function readDesktopInvocationRejectionDiagnostic(
  source: unknown,
): DesktopInvocationRejectionDiagnostic | null {
  if (typeof source !== "object" || source === null) return null;
  try {
    const [version, reason, adapter] = PROPERTIES.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    });
    return version === 1
      ? desktopInvocationRejectionDiagnostic(reason, adapter)
      : null;
  } catch {
    return null;
  }
}

export interface DesktopInvocationAdmissionDiagnostic {
  readonly desktop_invocation_admission_version: 1;
  readonly desktop_invocation_admission_reason: DesktopInvocationAdmissionReason;
}

const ADMISSION_PROPERTIES = [
  "desktop_invocation_admission_version",
  "desktop_invocation_admission_reason",
] as const satisfies readonly (keyof DesktopInvocationAdmissionDiagnostic)[];

export const DESKTOP_INVOCATION_ADMISSION_PROPERTIES: ReadonlySet<string> =
  new Set(ADMISSION_PROPERTIES);

/** The complete admission group, or null unless it refines a complete
 * `execution_admission` group, which already names a selected native command
 * set, with a listed admission class. */
export function desktopInvocationAdmissionDiagnostic(
  rejection: DesktopInvocationRejectionDiagnostic | null,
  admission: unknown,
): DesktopInvocationAdmissionDiagnostic | null {
  if (rejection?.desktop_invocation_rejection_reason !== "execution_admission")
    return null;
  const known = ADMISSION_REASONS.find((value) => value === admission);
  return known
    ? Object.freeze({
        desktop_invocation_admission_version: 1,
        desktop_invocation_admission_reason: known,
      })
    : null;
}

/** Read the complete admission group from any property bag's own data
 * properties, joined to an already validated rejection group, or nothing at
 * all. A getter never runs; a throwing proxy reads as nothing. */
export function readDesktopInvocationAdmissionDiagnostic(
  source: unknown,
  rejection: DesktopInvocationRejectionDiagnostic | null,
): DesktopInvocationAdmissionDiagnostic | null {
  if (!rejection || typeof source !== "object" || source === null) return null;
  try {
    const [version, reason] = ADMISSION_PROPERTIES.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    });
    return version === 1
      ? desktopInvocationAdmissionDiagnostic(rejection, reason)
      : null;
  } catch {
    return null;
  }
}

export interface DesktopInvocationSpawnHintDiagnostic {
  readonly desktop_invocation_spawn_hint_version: 1;
  readonly desktop_invocation_spawn_os_code_hint: DesktopInvocationSpawnOsCodeHint;
}

const SPAWN_HINT_PROPERTIES = [
  "desktop_invocation_spawn_hint_version",
  "desktop_invocation_spawn_os_code_hint",
] as const satisfies readonly (keyof DesktopInvocationSpawnHintDiagnostic)[];

export const DESKTOP_INVOCATION_SPAWN_HINT_PROPERTIES: ReadonlySet<string> =
  new Set(SPAWN_HINT_PROPERTIES);

/** Only a validated `spawn_failed` group, which a selected native command set
 * reported, can carry a hint. */
function refinesSpawnFailure(
  rejection: DesktopInvocationRejectionDiagnostic | null,
): boolean {
  return (
    rejection?.desktop_invocation_rejection_reason === "spawn_failed" &&
    rejection.desktop_invocation_rejection_adapter !== "not_selected"
  );
}

/** The complete hint group, or null unless it refines a complete
 * `spawn_failed` group with a listed hint. */
export function desktopInvocationSpawnHintDiagnostic(
  rejection: DesktopInvocationRejectionDiagnostic | null,
  hint: unknown,
): DesktopInvocationSpawnHintDiagnostic | null {
  if (!refinesSpawnFailure(rejection)) return null;
  const known = SPAWN_OS_CODE_HINTS.find((value) => value === hint);
  return known
    ? Object.freeze({
        desktop_invocation_spawn_hint_version: 1,
        desktop_invocation_spawn_os_code_hint: known,
      })
    : null;
}

/** Read the complete hint group from any property bag's own data properties,
 * joined to an already validated `spawn_failed` group, or nothing at all. No
 * property is read without that group. A getter never runs; a throwing proxy
 * reads as nothing. */
export function readDesktopInvocationSpawnHintDiagnostic(
  source: unknown,
  rejection: DesktopInvocationRejectionDiagnostic | null,
): DesktopInvocationSpawnHintDiagnostic | null {
  if (
    !refinesSpawnFailure(rejection) ||
    typeof source !== "object" ||
    source === null
  )
    return null;
  try {
    const [version, hint] = SPAWN_HINT_PROPERTIES.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    });
    return version === 1
      ? desktopInvocationSpawnHintDiagnostic(rejection, hint)
      : null;
  } catch {
    return null;
  }
}

export interface DesktopInvocationUnknownDiagnostic {
  readonly desktop_invocation_unknown_version: 1;
  readonly desktop_invocation_unknown_class: DesktopInvocationUnknownClass;
}

const UNKNOWN_PROPERTIES = [
  "desktop_invocation_unknown_version",
  "desktop_invocation_unknown_class",
] as const satisfies readonly (keyof DesktopInvocationUnknownDiagnostic)[];

export const DESKTOP_INVOCATION_UNKNOWN_PROPERTIES: ReadonlySet<string> =
  new Set(UNKNOWN_PROPERTIES);

/** Only a validated `unknown` group from the authorized command set can carry
 * an unknown class; a legacy, compatibility or unselected invocation never
 * does. The adapter names the selected command set, not the binary or cause. */
function refinesAuthorizedUnknown(
  rejection: DesktopInvocationRejectionDiagnostic | null,
): boolean {
  return (
    rejection?.desktop_invocation_rejection_reason === "unknown" &&
    rejection.desktop_invocation_rejection_adapter === "authorized_native"
  );
}

/** The complete unknown class group, or null unless it refines a complete
 * authorized `unknown` group with a listed class. */
export function desktopInvocationUnknownDiagnostic(
  rejection: DesktopInvocationRejectionDiagnostic | null,
  unknownClass: unknown,
): DesktopInvocationUnknownDiagnostic | null {
  if (!refinesAuthorizedUnknown(rejection)) return null;
  const known = UNKNOWN_CLASSES.find((value) => value === unknownClass);
  return known
    ? Object.freeze({
        desktop_invocation_unknown_version: 1,
        desktop_invocation_unknown_class: known,
      })
    : null;
}

/** Read the complete unknown class group from any property bag's own data
 * properties, joined to an already validated authorized `unknown` group, or
 * nothing at all. No property is read without that group. A getter never
 * runs; a throwing proxy reads as nothing. */
export function readDesktopInvocationUnknownDiagnostic(
  source: unknown,
  rejection: DesktopInvocationRejectionDiagnostic | null,
): DesktopInvocationUnknownDiagnostic | null {
  if (
    !refinesAuthorizedUnknown(rejection) ||
    typeof source !== "object" ||
    source === null
  )
    return null;
  try {
    const [version, unknownClass] = UNKNOWN_PROPERTIES.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    });
    return version === 1
      ? desktopInvocationUnknownDiagnostic(rejection, unknownClass)
      : null;
  } catch {
    return null;
  }
}
