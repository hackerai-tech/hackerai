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

/** stream_lifecycle.rs `STOP_UNCONFIRMED`, the public product message. */
const STOP_UNCONFIRMED_MESSAGE =
  "Desktop could not confirm an earlier command stopped. New commands are blocked for this session. Close and reopen Desktop before running more commands.";

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
    [STOP_UNCONFIRMED_MESSAGE, "lifecycle_stop_unconfirmed"],
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

/** The native stream fence's first origin: a closed class of the existing
 * code path that first set the process-lifetime fence. It names the owner's
 * bounded final outcome or the cancellation wait, never the process, its
 * output, an OS error, or why the tree could not be confirmed stopped. */
const STREAM_FENCE_ORIGINS = [
  "owner_timeout",
  "owner_process_error",
  "owner_stop_requested",
  "owner_delivery_failed",
  "owner_outcome_missing",
  "cancel_wait_timeout",
] as const;

export type DesktopStreamFenceOrigin = (typeof STREAM_FENCE_ORIGINS)[number];

/** Only an explicit stop's cleanup can carry its stop request source. */
const STREAM_FENCE_STOP_ORIGIN = "owner_stop_requested";

/** The owner's own timeout, whose cleanup, and that cleanup's taskkill
 * receipt, join only an origin and cleanup unchanged by reading them. */
const STREAM_FENCE_TIMEOUT_ORIGIN = "owner_timeout";

/** Only these origins can carry a cleanup failure: the owner's requested stop
 * and its own timeout. A native app before the timeout's leg sends only its
 * origin, which is still accepted alone. */
const STREAM_FENCE_CLEANUP_ORIGINS = [
  STREAM_FENCE_STOP_ORIGIN,
  STREAM_FENCE_TIMEOUT_ORIGIN,
] as const;

function carriesCleanup(origin: DesktopStreamFenceOrigin | null): boolean {
  return STREAM_FENCE_CLEANUP_ORIGINS.some((known) => known === origin);
}

/** A closed class of which bounded steps of an `owner_stop_requested` owner's
 * stop or an `owner_timeout` owner's cleanup failed: the tree's stopped
 * verification, the wait for its leader, or both, and whether that wait timed
 * out or failed. It never names the process, its output, an OS error, a time
 * or a raw comparison. */
const STREAM_FENCE_CLEANUP_FAILURES = [
  "tree_unconfirmed",
  "leader_wait_timed_out",
  "leader_wait_failed",
  "tree_and_leader_wait_timed_out",
  "tree_and_leader_wait_failed",
] as const;

export type DesktopStreamFenceCleanupFailure =
  (typeof STREAM_FENCE_CLEANUP_FAILURES)[number];

/** Only this cleanup failure of an explicit stop or an owner timeout, whose
 * leader was reaped, can carry a Windows taskkill receipt. */
const STREAM_FENCE_TASKKILL_FAILURE = "tree_unconfirmed";

function carriesWindowsTaskkill(
  origin: DesktopStreamFenceOrigin | null,
  cleanupFailure: DesktopStreamFenceCleanupFailure | null | undefined,
): boolean {
  return (
    carriesCleanup(origin) && cleanupFailure === STREAM_FENCE_TASKKILL_FAILURE
  );
}

/** A closed class of how the real Windows `taskkill` step of an
 * `owner_stop_requested` stop or an `owner_timeout` owner's cleanup with
 * `tree_unconfirmed` failed: a nonzero exit
 * status, or an error collecting its output. It never names the process, the
 * command, its output or an OS error; only a `nonzero_exit` may carry the
 * signed 32-bit status code itself. */
const STREAM_FENCE_TASKKILL_OUTCOMES = [
  "nonzero_exit",
  "output_error",
] as const;

export type DesktopStreamFenceWindowsTaskkillOutcome =
  (typeof STREAM_FENCE_TASKKILL_OUTCOMES)[number];

/** A nonzero signed 32-bit exit status, as Rust's `ExitStatus::code`. */
function isNonzeroI32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value !== 0 &&
    value >= -0x8000_0000 &&
    value <= 0x7fff_ffff
  );
}

/** A closed class of taskkill's own report for a nonzero exit with a code:
 * its exact English report that the requested root PID was not found, under
 * its not-found exit code, or anything else. A command report only, never
 * evidence of the tree's state, its descendants or a localized message. */
const STREAM_FENCE_TASKKILL_ROOT_REPORTS = [
  "requested_pid_not_found",
  "unclassified",
] as const;

export type DesktopStreamFenceWindowsTaskkillRootReport =
  (typeof STREAM_FENCE_TASKKILL_ROOT_REPORTS)[number];

/** The only exit code that can carry `requested_pid_not_found`. */
const STREAM_FENCE_TASKKILL_NOT_FOUND_EXIT = 128;

/** A listed root report valid for `exitCode`, or undefined. */
function knownRootReport(
  rootReport: unknown,
  exitCode: number,
): DesktopStreamFenceWindowsTaskkillRootReport | undefined {
  const known = STREAM_FENCE_TASKKILL_ROOT_REPORTS.find(
    (value) => value === rootReport,
  );
  return known === "requested_pid_not_found" &&
    exitCode !== STREAM_FENCE_TASKKILL_NOT_FOUND_EXIT
    ? undefined
    : known;
}

/** Only an explicit stop's validated root report of the not-found exit code,
 * of either class, can carry its stop request's first source; every other
 * code, and every owner timeout, never does. */
function carriesStopRequestSource(
  origin: DesktopStreamFenceOrigin | null,
  rootReport: DesktopStreamFenceWindowsTaskkillRootReport | undefined,
  exitCode: number | undefined,
): boolean {
  return (
    origin === STREAM_FENCE_STOP_ORIGIN &&
    exitCode === STREAM_FENCE_TASKKILL_NOT_FOUND_EXIT &&
    (rootReport === "requested_pid_not_found" || rootReport === "unclassified")
  );
}

/** A closed class of the native call path that first asked the owner, whose
 * stop with taskkill's not-found exit code then set the fence, to stop: the cancel IPC,
 * a page generation invalidation (a committed document or a lost web
 * process), or normal application exit. It names the Rust caller only: never
 * a human action, the process, a PID, a resource or a time. */
const STREAM_FENCE_STOP_REQUEST_SOURCES = [
  "cancel_ipc",
  "document_invalidation",
  "application_exit",
] as const;

export type DesktopStreamFenceStopRequestSource =
  (typeof STREAM_FENCE_STOP_REQUEST_SOURCES)[number];

/** A closed class of how the final existing `kill(-pgid, 0)` probe of a
 * Darwin Desktop `owner_stop_requested` stop's `tree_unconfirmed` cleanup kept
 * the process group unconfirmed: it saw a member, was denied (`EPERM`), or
 * failed otherwise. Only `ESRCH` confirms the group is gone, so it never names
 * an errno, a PID, a process, or which members survived. */
const STREAM_FENCE_DARWIN_GROUP_PROBES = [
  "group_visible",
  "probe_denied",
  "probe_failed",
] as const;

export type DesktopStreamFenceDarwinGroupProbe =
  (typeof STREAM_FENCE_DARWIN_GROUP_PROBES)[number];

/** Only an explicit stop's `tree_unconfirmed` cleanup can carry the Darwin
 * stop's first source and final group probe; never an owner timeout's, a
 * combined leg's or one beside any Windows taskkill receipt. */
function carriesDarwinStop(
  origin: DesktopStreamFenceOrigin | null,
  cleanupFailure: DesktopStreamFenceCleanupFailure | null | undefined,
): boolean {
  return (
    origin === STREAM_FENCE_STOP_ORIGIN &&
    cleanupFailure === STREAM_FENCE_TASKKILL_FAILURE
  );
}

/** The Darwin stop's first source and final group probe class. */
export interface NativeStreamFenceDarwinStop {
  readonly source: DesktopStreamFenceStopRequestSource;
  readonly groupProbe: DesktopStreamFenceDarwinGroupProbe;
}

/** Only this origin can carry its matched owner's phase. */
const STREAM_FENCE_OWNER_PHASE_ORIGIN = "cancel_wait_timeout";

/** A closed class of the last step the owner matched by a timed-out explicit
 * cancellation wait had published when that timeout first set the fence, or
 * `released` once that owner's registration was gone. It names the owner's
 * own code path only: never the process, its output, a time or an OS error,
 * and never whether a process survived or a step ran. */
const STREAM_FENCE_CANCEL_WAIT_OWNER_PHASES = [
  "owner_pending",
  "owner_streaming",
  "stop_cleanup_tree_and_leader_pending",
  "stop_cleanup_tree_pending",
  "stop_cleanup_leader_pending",
  "owner_cleanup",
  "terminal_delivery",
  "released",
] as const;

export type DesktopStreamFenceCancelWaitOwnerPhase =
  (typeof STREAM_FENCE_CANCEL_WAIT_OWNER_PHASES)[number];

export type NativeStreamFenceWindowsTaskkill =
  | {
      readonly outcome: "nonzero_exit";
      /** Absent when the status had no code. */
      readonly exitCode?: number;
      /** Only from the v2 receipt, which always has a code. */
      readonly rootReport?: DesktopStreamFenceWindowsTaskkillRootReport;
    }
  | {
      readonly outcome: "output_error";
      readonly exitCode?: never;
      readonly rootReport?: never;
    };

/** A plain object's own string keys, or null for anything else or any symbol.
 * Never runs a getter and never throws. */
function plainOwnKeys(value: unknown): string[] | null {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length > 0
    )
      return null;
    return Object.getOwnPropertyNames(value);
  } catch {
    return null;
  }
}

/** The own data values of `keys` on `value`, or null if any is missing or an
 * accessor. Never runs a getter and never throws. */
function readOwnDataValues(
  value: object,
  keys: readonly string[],
): unknown[] | null {
  try {
    const values: unknown[] = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return null;
      values.push(descriptor.value);
    }
    return values;
  } catch {
    return null;
  }
}

/** The own data values of exactly `keys` on a plain object, or null. Never
 * runs a getter and never throws. */
function readClosedOwnData(
  value: unknown,
  keys: readonly string[],
): unknown[] | null {
  const own = plainOwnKeys(value);
  if (
    !own ||
    own.length !== keys.length ||
    !keys.every((key) => own.includes(key))
  )
    return null;
  return readOwnDataValues(value as object, keys);
}

const STREAM_FENCE_REJECTION_KEYS = ["message", "streamFence"] as const;
const STREAM_FENCE_CLEANUP_KEY = "streamFenceCleanup";
const STREAM_FENCE_TASKKILL_KEY = "streamFenceWindowsTaskkill";
const STREAM_FENCE_OWNER_PHASE_KEY = "streamFenceCancelWaitOwnerPhase";
const STREAM_FENCE_STOP_REQUEST_SOURCE_KEY = "streamFenceStopRequestSource";
const STREAM_FENCE_DARWIN_STOP_KEY = "streamFenceDarwinStop";
const STREAM_FENCE_DARWIN_STOP_KEYS = [
  "version",
  "source",
  "groupProbe",
] as const;
const STREAM_FENCE_ORIGIN_KEYS = ["version", "origin"] as const;
const STREAM_FENCE_OWNER_PHASE_KEYS = ["version", "phase"] as const;
const STREAM_FENCE_STOP_REQUEST_SOURCE_KEYS = ["version", "source"] as const;
const STREAM_FENCE_CLEANUP_KEYS = ["version", "failure"] as const;
const STREAM_FENCE_TASKKILL_KEYS = ["version", "outcome"] as const;
const STREAM_FENCE_TASKKILL_CODE_KEYS = [
  ...STREAM_FENCE_TASKKILL_KEYS,
  "exitCode",
] as const;
const STREAM_FENCE_TASKKILL_ROOT_REPORT_KEYS = [
  ...STREAM_FENCE_TASKKILL_CODE_KEYS,
  "rootReport",
] as const;

export interface NativeStreamFenceRejection {
  /** Always exactly the public `STOP_UNCONFIRMED` message. */
  readonly message: string;
  /** Null unless the carried origin is the closed v1 shape. */
  readonly origin: DesktopStreamFenceOrigin | null;
  /** Present only beside an `owner_stop_requested` or `owner_timeout` origin,
   * for the closed v1 `streamFenceCleanup` sibling. */
  readonly cleanupFailure?: DesktopStreamFenceCleanupFailure;
  /** Present only beside an `owner_stop_requested` or `owner_timeout`
   * origin's `tree_unconfirmed` cleanup failure, for the closed v1 or v2
   * `streamFenceWindowsTaskkill` sibling. */
  readonly windowsTaskkill?: NativeStreamFenceWindowsTaskkill;
  /** Present only beside a `cancel_wait_timeout` origin, for the closed v1
   * `streamFenceCancelWaitOwnerPhase` sibling. */
  readonly cancelWaitOwnerPhase?: DesktopStreamFenceCancelWaitOwnerPhase;
  /** Present only beside an `owner_stop_requested` origin's v2 taskkill
   * receipt of the not-found exit code, either root report, for the closed
   * v1 `streamFenceStopRequestSource` sibling. */
  readonly stopRequestSource?: DesktopStreamFenceStopRequestSource;
  /** Present only beside an `owner_stop_requested` origin's
   * `tree_unconfirmed` cleanup failure without any taskkill sibling, for the
   * closed v1 `streamFenceDarwinStop` sibling. */
  readonly darwinStop?: NativeStreamFenceDarwinStop;
}

/** The closed v1 Darwin stop in `receipt`, exactly `{ version: 1, source,
 * groupProbe }` with a listed source and probe class, or null. Never throws. */
function parseStreamFenceDarwinStop(
  receipt: unknown,
): NativeStreamFenceDarwinStop | null {
  const values = readClosedOwnData(receipt, STREAM_FENCE_DARWIN_STOP_KEYS);
  if (values?.[0] !== 1) return null;
  const source = STREAM_FENCE_STOP_REQUEST_SOURCES.find(
    (known) => known === values[1],
  );
  const groupProbe = STREAM_FENCE_DARWIN_GROUP_PROBES.find(
    (known) => known === values[2],
  );
  return source && groupProbe ? Object.freeze({ source, groupProbe }) : null;
}

/** The closed v1 stop request source in `receipt`, or null. Never throws. */
function parseStreamFenceStopRequestSource(
  receipt: unknown,
): DesktopStreamFenceStopRequestSource | null {
  const values = readClosedOwnData(
    receipt,
    STREAM_FENCE_STOP_REQUEST_SOURCE_KEYS,
  );
  return values?.[0] === 1
    ? (STREAM_FENCE_STOP_REQUEST_SOURCES.find((known) => known === values[1]) ??
        null)
    : null;
}

/** The closed v1 owner phase in `receipt`, or null. Never throws. */
function parseStreamFenceOwnerPhase(
  receipt: unknown,
): DesktopStreamFenceCancelWaitOwnerPhase | null {
  const values = readClosedOwnData(receipt, STREAM_FENCE_OWNER_PHASE_KEYS);
  return values?.[0] === 1
    ? (STREAM_FENCE_CANCEL_WAIT_OWNER_PHASES.find(
        (known) => known === values[1],
      ) ?? null)
    : null;
}

/** The closed taskkill receipt in `receipt`, or null. Version 1 is exactly
 * `{ version: 1, outcome }`, or `{ version: 1, outcome: "nonzero_exit",
 * exitCode }` with a nonzero signed 32-bit code. Version 2, which only a
 * native app offered the root report opt-in sends, is exactly
 * `{ version: 2, outcome: "nonzero_exit", exitCode, rootReport }` with such
 * a code and a listed root report, `requested_pid_not_found` only beside the
 * not-found exit code. Never throws. */
function parseStreamFenceWindowsTaskkill(
  receipt: unknown,
): NativeStreamFenceWindowsTaskkill | null {
  const keyCount = plainOwnKeys(receipt)?.length;
  const keys = [
    STREAM_FENCE_TASKKILL_KEYS,
    STREAM_FENCE_TASKKILL_CODE_KEYS,
    STREAM_FENCE_TASKKILL_ROOT_REPORT_KEYS,
  ].find((candidate) => candidate.length === keyCount);
  const values = keys && readClosedOwnData(receipt, keys);
  if (!values) return null;
  const [version, outcome, exitCode, rootReport] = values;
  // Only v2 carries a root report, and v2 always has one.
  const v2 = keys === STREAM_FENCE_TASKKILL_ROOT_REPORT_KEYS;
  if (version !== (v2 ? 2 : 1)) return null;
  let parsed: NativeStreamFenceWindowsTaskkill | null = null;
  if (keys === STREAM_FENCE_TASKKILL_KEYS) {
    if (outcome === "nonzero_exit" || outcome === "output_error")
      parsed = { outcome };
  } else if (outcome === "nonzero_exit" && isNonzeroI32(exitCode)) {
    const report = v2 ? knownRootReport(rootReport, exitCode) : undefined;
    if (!v2) parsed = { outcome, exitCode };
    else if (report) parsed = { outcome, exitCode, rootReport: report };
  }
  return parsed && Object.freeze(parsed);
}

/** The closed v1 cleanup failure in `cleanup`, or null. Never throws. */
function parseStreamFenceCleanup(
  cleanup: unknown,
): DesktopStreamFenceCleanupFailure | null {
  const values = readClosedOwnData(cleanup, STREAM_FENCE_CLEANUP_KEYS);
  return values?.[0] === 1
    ? (STREAM_FENCE_CLEANUP_FAILURES.find((known) => known === values[1]) ??
        null)
    : null;
}

/** Recheck the timeout and its tree-only cleanup after reading the optional
 * taskkill receipt. The cleanup must still match after reading the fence.
 * Never throws; a getter never runs. */
function nativeTimeoutTreePairsUnchanged(error: object): boolean {
  const cleanup = parseStreamFenceCleanup(
    readOwnDataValues(error, [STREAM_FENCE_CLEANUP_KEY])?.[0],
  );
  if (cleanup !== STREAM_FENCE_TASKKILL_FAILURE) return false;
  const fence = readClosedOwnData(
    readOwnDataValues(error, [STREAM_FENCE_REJECTION_KEYS[1]])?.[0],
    STREAM_FENCE_ORIGIN_KEYS,
  );
  if (fence?.[0] !== 1 || fence[1] !== STREAM_FENCE_TIMEOUT_ORIGIN)
    return false;
  // Reading the fence can change the cleanup on a proxy, so it is read last.
  return (
    parseStreamFenceCleanup(
      readOwnDataValues(error, [STREAM_FENCE_CLEANUP_KEY])?.[0],
    ) === STREAM_FENCE_TASKKILL_FAILURE
  );
}

/** The opted-in authorized stream command's rejection for its exact
 * unconfirmed stop: a plain object whose only own properties are the data
 * properties `message`, exactly the public fence message, and `streamFence`,
 * `{ version: 1, origin }` with a listed origin, optionally beside a
 * `streamFenceCleanup` sibling, `{ version: 1, failure }` with a listed
 * failure, and beside that sibling optionally a `streamFenceWindowsTaskkill`
 * sibling, the closed v1 or v2 taskkill receipt. Any other value, including every
 * string rejection, is null, so the caller keeps the rejection exactly as
 * received. A malformed `streamFence` keeps only the exact message; a
 * malformed cleanup, or one beside any origin other than
 * `owner_stop_requested` or `owner_timeout`, which is then never read, keeps
 * the exact message and origin, as does an `owner_timeout` cleanup whose read
 * changed that validated fence. A taskkill receipt is read only beside either
 * origin's `tree_unconfirmed` failure; a malformed one, one beside any other
 * origin or cleanup failure, which is then never read, or an `owner_timeout`
 * one whose read changed that validated fence or cleanup, keeps the exact
 * message, origin and cleanup failure. Separately, a
 * `streamFenceCancelWaitOwnerPhase` sibling, `{ version: 1, phase }` with a
 * listed phase, is read only beside a `cancel_wait_timeout` origin; a
 * malformed one, or one beside any other origin, keeps the exact message and
 * origin. Likewise a `streamFenceStopRequestSource` sibling,
 * `{ version: 1, source }` with a listed source, is read only beside an
 * `owner_stop_requested` origin's parsed v2 taskkill receipt of the not-found
 * exit code; a malformed one, or one beside anything else, including every
 * `owner_timeout`, keeps every other parsed receipt. Likewise a
 * `streamFenceDarwinStop` sibling, `{ version: 1, source, groupProbe }` with
 * a listed source and probe class, is read only beside an
 * `owner_stop_requested` origin's `tree_unconfirmed` cleanup failure and no
 * taskkill sibling; a malformed one, or one beside anything else, keeps every
 * other parsed receipt. Never throws; a getter never runs. */
export function parseNativeStreamFenceRejection(
  error: unknown,
): NativeStreamFenceRejection | null {
  const own = plainOwnKeys(error);
  const sibling = own?.includes(STREAM_FENCE_CLEANUP_KEY) === true;
  const taskkillSibling =
    sibling && own?.includes(STREAM_FENCE_TASKKILL_KEY) === true;
  const darwinSibling =
    sibling && own?.includes(STREAM_FENCE_DARWIN_STOP_KEY) === true;
  const phaseSibling = own?.includes(STREAM_FENCE_OWNER_PHASE_KEY) === true;
  const sourceSibling =
    own?.includes(STREAM_FENCE_STOP_REQUEST_SOURCE_KEY) === true;
  if (
    !own ||
    own.length !==
      STREAM_FENCE_REJECTION_KEYS.length +
        (sibling ? 1 : 0) +
        (taskkillSibling ? 1 : 0) +
        (darwinSibling ? 1 : 0) +
        (phaseSibling ? 1 : 0) +
        (sourceSibling ? 1 : 0) ||
    !STREAM_FENCE_REJECTION_KEYS.every((key) => own.includes(key))
  )
    return null;
  const values = readOwnDataValues(
    error as object,
    STREAM_FENCE_REJECTION_KEYS,
  );
  if (!values || values[0] !== STOP_UNCONFIRMED_MESSAGE) return null;
  const fence = readClosedOwnData(values[1], STREAM_FENCE_ORIGIN_KEYS);
  const origin =
    fence?.[0] === 1
      ? (STREAM_FENCE_ORIGINS.find((known) => known === fence[1]) ?? null)
      : null;
  const parsedCleanup =
    sibling && carriesCleanup(origin)
      ? parseStreamFenceCleanup(
          readOwnDataValues(error as object, [STREAM_FENCE_CLEANUP_KEY])?.[0],
        )
      : null;
  // Reading the cleanup can change the fence on a proxy: a timeout's cleanup
  // joins only the exact origin pair validated above, else drops alone.
  const recheckedFence =
    parsedCleanup && origin === STREAM_FENCE_TIMEOUT_ORIGIN
      ? readClosedOwnData(
          readOwnDataValues(error as object, [
            STREAM_FENCE_REJECTION_KEYS[1],
          ])?.[0],
          STREAM_FENCE_ORIGIN_KEYS,
        )
      : null;
  const cleanupFailure =
    origin !== STREAM_FENCE_TIMEOUT_ORIGIN ||
    (recheckedFence?.[0] === 1 && recheckedFence[1] === origin)
      ? parsedCleanup
      : null;
  const parsedTaskkill =
    taskkillSibling && carriesWindowsTaskkill(origin, cleanupFailure)
      ? parseStreamFenceWindowsTaskkill(
          readOwnDataValues(error as object, [STREAM_FENCE_TASKKILL_KEY])?.[0],
        )
      : null;
  // Reading the receipt can change the fence or cleanup on a proxy: a
  // timeout's receipt joins only the exact pairs validated above, else drops
  // alone.
  const windowsTaskkill =
    parsedTaskkill &&
    origin === STREAM_FENCE_TIMEOUT_ORIGIN &&
    !nativeTimeoutTreePairsUnchanged(error as object)
      ? null
      : parsedTaskkill;
  const cancelWaitOwnerPhase =
    phaseSibling && origin === STREAM_FENCE_OWNER_PHASE_ORIGIN
      ? parseStreamFenceOwnerPhase(
          readOwnDataValues(error as object, [
            STREAM_FENCE_OWNER_PHASE_KEY,
          ])?.[0],
        )
      : null;
  const stopRequestSource =
    sourceSibling &&
    carriesStopRequestSource(
      origin,
      windowsTaskkill?.rootReport,
      windowsTaskkill?.exitCode,
    )
      ? parseStreamFenceStopRequestSource(
          readOwnDataValues(error as object, [
            STREAM_FENCE_STOP_REQUEST_SOURCE_KEY,
          ])?.[0],
        )
      : null;
  // Platform-exclusive: never beside any taskkill sibling, valid or not.
  const darwinStop =
    darwinSibling &&
    !taskkillSibling &&
    carriesDarwinStop(origin, cleanupFailure)
      ? parseStreamFenceDarwinStop(
          readOwnDataValues(error as object, [
            STREAM_FENCE_DARWIN_STOP_KEY,
          ])?.[0],
        )
      : null;
  return Object.freeze({
    message: STOP_UNCONFIRMED_MESSAGE,
    origin,
    ...(cleanupFailure && { cleanupFailure }),
    ...(windowsTaskkill && { windowsTaskkill }),
    ...(cancelWaitOwnerPhase && { cancelWaitOwnerPhase }),
    ...(stopRequestSource && { stopRequestSource }),
    ...(darwinStop && { darwinStop }),
  });
}

interface DesktopStreamFenceOriginGroup {
  readonly desktop_stream_fence_version: 1;
  readonly desktop_stream_fence_origin: DesktopStreamFenceOrigin;
}

interface DesktopStreamFenceCleanupGroup {
  readonly desktop_stream_fence_cleanup_version: 1;
  readonly desktop_stream_fence_cleanup_failure: DesktopStreamFenceCleanupFailure;
}

interface DesktopStreamFenceWindowsTaskkillGroup {
  readonly desktop_stream_fence_windows_taskkill_version: 1;
  readonly desktop_stream_fence_windows_taskkill_outcome: DesktopStreamFenceWindowsTaskkillOutcome;
  /** Only for a `nonzero_exit` outcome whose status had a code. */
  readonly desktop_stream_fence_windows_taskkill_exit_code?: number;
  /** The root report pair, only beside that code; `requested_pid_not_found`
   * only beside the not-found code. */
  readonly desktop_stream_fence_windows_taskkill_root_report_version?: 1;
  readonly desktop_stream_fence_windows_taskkill_root_report?: DesktopStreamFenceWindowsTaskkillRootReport;
  /** The first stop request source pair, only beside an
   * `owner_stop_requested` origin's root report of the not-found code. */
  readonly desktop_stream_fence_stop_request_source_version?: 1;
  readonly desktop_stream_fence_stop_request_source?: DesktopStreamFenceStopRequestSource;
}

interface NoStreamFenceWindowsTaskkillGroup {
  readonly desktop_stream_fence_windows_taskkill_version?: never;
  readonly desktop_stream_fence_windows_taskkill_outcome?: never;
  readonly desktop_stream_fence_windows_taskkill_exit_code?: never;
  readonly desktop_stream_fence_windows_taskkill_root_report_version?: never;
  readonly desktop_stream_fence_windows_taskkill_root_report?: never;
  readonly desktop_stream_fence_stop_request_source_version?: never;
  readonly desktop_stream_fence_stop_request_source?: never;
}

/** Darwin Desktop's explicit stop: its first source and its tree-only
 * cleanup's final group probe class, one versioned group. */
interface DesktopStreamFenceDarwinStopGroup {
  readonly desktop_stream_fence_darwin_stop_version: 1;
  readonly desktop_stream_fence_darwin_stop_source: DesktopStreamFenceStopRequestSource;
  readonly desktop_stream_fence_darwin_stop_group_probe: DesktopStreamFenceDarwinGroupProbe;
}

interface NoStreamFenceDarwinStopGroup {
  readonly desktop_stream_fence_darwin_stop_version?: never;
  readonly desktop_stream_fence_darwin_stop_source?: never;
  readonly desktop_stream_fence_darwin_stop_group_probe?: never;
}

interface DesktopStreamFenceOwnerPhaseGroup {
  readonly desktop_stream_fence_cancel_wait_owner_phase_version: 1;
  readonly desktop_stream_fence_cancel_wait_owner_phase: DesktopStreamFenceCancelWaitOwnerPhase;
}

interface NoStreamFenceOwnerPhaseGroup {
  readonly desktop_stream_fence_cancel_wait_owner_phase_version?: never;
  readonly desktop_stream_fence_cancel_wait_owner_phase?: never;
}

/** The fence origin pair, only beside `owner_stop_requested` or
 * `owner_timeout` the complete cleanup pair, only beside either origin's
 * `tree_unconfirmed` failure the complete Windows taskkill group, with the
 * stop request source pair only beside an `owner_stop_requested` origin's
 * root report of the not-found code, or, exclusively, only beside an
 * `owner_stop_requested` origin's `tree_unconfirmed` failure the complete
 * Darwin stop group, and only beside `cancel_wait_timeout` the complete owner
 * phase pair. */
export type DesktopStreamFenceDiagnostic = DesktopStreamFenceOriginGroup &
  (
    | (DesktopStreamFenceCleanupGroup &
        (
          | (DesktopStreamFenceWindowsTaskkillGroup &
              NoStreamFenceDarwinStopGroup)
          | (NoStreamFenceWindowsTaskkillGroup &
              (
                DesktopStreamFenceDarwinStopGroup | NoStreamFenceDarwinStopGroup
              ))
        ) &
        NoStreamFenceOwnerPhaseGroup)
    | ({
        readonly desktop_stream_fence_cleanup_version?: never;
        readonly desktop_stream_fence_cleanup_failure?: never;
      } & NoStreamFenceWindowsTaskkillGroup &
        NoStreamFenceDarwinStopGroup &
        (DesktopStreamFenceOwnerPhaseGroup | NoStreamFenceOwnerPhaseGroup))
  );

const STREAM_FENCE_PROPERTIES = [
  "desktop_stream_fence_version",
  "desktop_stream_fence_origin",
] as const satisfies readonly (keyof DesktopStreamFenceOriginGroup)[];

const STREAM_FENCE_CLEANUP_PROPERTIES = [
  "desktop_stream_fence_cleanup_version",
  "desktop_stream_fence_cleanup_failure",
] as const satisfies readonly (keyof DesktopStreamFenceCleanupGroup)[];

const STREAM_FENCE_TASKKILL_EXIT_CODE_PROPERTY =
  "desktop_stream_fence_windows_taskkill_exit_code";

const STREAM_FENCE_TASKKILL_PROPERTIES = [
  "desktop_stream_fence_windows_taskkill_version",
  "desktop_stream_fence_windows_taskkill_outcome",
] as const satisfies readonly (keyof DesktopStreamFenceWindowsTaskkillGroup)[];

const STREAM_FENCE_TASKKILL_ROOT_REPORT_PROPERTIES = [
  "desktop_stream_fence_windows_taskkill_root_report_version",
  "desktop_stream_fence_windows_taskkill_root_report",
] as const satisfies readonly (keyof DesktopStreamFenceWindowsTaskkillGroup)[];

const STREAM_FENCE_STOP_REQUEST_SOURCE_PROPERTIES = [
  "desktop_stream_fence_stop_request_source_version",
  "desktop_stream_fence_stop_request_source",
] as const satisfies readonly (keyof DesktopStreamFenceWindowsTaskkillGroup)[];

const STREAM_FENCE_DARWIN_STOP_PROPERTIES = [
  "desktop_stream_fence_darwin_stop_version",
  "desktop_stream_fence_darwin_stop_source",
  "desktop_stream_fence_darwin_stop_group_probe",
] as const satisfies readonly (keyof DesktopStreamFenceDarwinStopGroup)[];

const STREAM_FENCE_OWNER_PHASE_PROPERTIES = [
  "desktop_stream_fence_cancel_wait_owner_phase_version",
  "desktop_stream_fence_cancel_wait_owner_phase",
] as const satisfies readonly (keyof DesktopStreamFenceOwnerPhaseGroup)[];

/** Which of the bridge's two `cancel_stream_command` IPC callers the renderer
 * attempted for this invocation before its first accepted terminal: the relay
 * `command_cancel` handler, the operation router's output overflow cleanup,
 * both, or neither. An attempt is the renderer calling the IPC, never who
 * initiated the stop or which call reached native code first. */
const STREAM_FENCE_RENDERER_CANCEL_ATTEMPTS = [
  "relay_command_cancel",
  "output_overflow",
  "both",
  "unobserved",
] as const;

export type DesktopStreamFenceRendererCancelAttempt =
  (typeof STREAM_FENCE_RENDERER_CANCEL_ATTEMPTS)[number];

export interface DesktopStreamFenceRendererCancelDiagnostic {
  readonly desktop_stream_fence_renderer_cancel_attempt_version: 1;
  readonly desktop_stream_fence_renderer_cancel_attempt: DesktopStreamFenceRendererCancelAttempt;
}

const STREAM_FENCE_RENDERER_CANCEL_PROPERTIES = [
  "desktop_stream_fence_renderer_cancel_attempt_version",
  "desktop_stream_fence_renderer_cancel_attempt",
] as const satisfies readonly (keyof DesktopStreamFenceRendererCancelDiagnostic)[];

/** Every group: the final whitelist strips every one and re-adds only the
 * validated copy. */
export const DESKTOP_STREAM_FENCE_PROPERTIES: ReadonlySet<string> = new Set([
  ...STREAM_FENCE_PROPERTIES,
  ...STREAM_FENCE_CLEANUP_PROPERTIES,
  ...STREAM_FENCE_TASKKILL_PROPERTIES,
  STREAM_FENCE_TASKKILL_EXIT_CODE_PROPERTY,
  ...STREAM_FENCE_TASKKILL_ROOT_REPORT_PROPERTIES,
  ...STREAM_FENCE_STOP_REQUEST_SOURCE_PROPERTIES,
  ...STREAM_FENCE_DARWIN_STOP_PROPERTIES,
  ...STREAM_FENCE_OWNER_PHASE_PROPERTIES,
  ...STREAM_FENCE_RENDERER_CANCEL_PROPERTIES,
]);

/** The Windows taskkill group's own properties. Any one present, valid or not,
 * keeps the Darwin stop group from being read beside it. Its refinements are
 * never read here: none is ever kept without that group. */
const STREAM_FENCE_WINDOWS_ONLY_PROPERTIES = [
  ...STREAM_FENCE_TASKKILL_PROPERTIES,
  STREAM_FENCE_TASKKILL_EXIT_CODE_PROPERTY,
] as const;

/** The complete Darwin stop group for a listed source and probe class, or
 * null. */
function darwinStopGroup(
  stopSource: unknown,
  groupProbe: unknown,
): DesktopStreamFenceDarwinStopGroup | null {
  const source = STREAM_FENCE_STOP_REQUEST_SOURCES.find(
    (value) => value === stopSource,
  );
  const probe = STREAM_FENCE_DARWIN_GROUP_PROBES.find(
    (value) => value === groupProbe,
  );
  return source && probe
    ? {
        desktop_stream_fence_darwin_stop_version: 1,
        desktop_stream_fence_darwin_stop_source: source,
        desktop_stream_fence_darwin_stop_group_probe: probe,
      }
    : null;
}

/** A taskkill outcome, code and root report, each still to be validated. */
interface UncheckedWindowsTaskkill {
  readonly outcome: unknown;
  readonly exitCode?: unknown;
  readonly rootReport?: unknown;
}

/** The complete taskkill group for a listed outcome, with the code only for a
 * `nonzero_exit` and only when it is a nonzero signed 32-bit integer; an
 * `undefined` code is an absent one. Any other combination is null. Beside
 * that code only, a listed root report valid for it adds its own pair; an
 * `undefined` or invalid one leaves the group without it. */
function windowsTaskkillGroup(
  outcome: unknown,
  exitCode: unknown,
  rootReport: unknown,
): DesktopStreamFenceWindowsTaskkillGroup | null {
  const known = STREAM_FENCE_TASKKILL_OUTCOMES.find(
    (value) => value === outcome,
  );
  if (!known) return null;
  if (exitCode === undefined)
    return {
      desktop_stream_fence_windows_taskkill_version: 1,
      desktop_stream_fence_windows_taskkill_outcome: known,
    };
  if (known !== "nonzero_exit" || !isNonzeroI32(exitCode)) return null;
  const report = knownRootReport(rootReport, exitCode);
  return {
    desktop_stream_fence_windows_taskkill_version: 1,
    desktop_stream_fence_windows_taskkill_outcome: known,
    desktop_stream_fence_windows_taskkill_exit_code: exitCode,
    ...(report &&
      ({
        desktop_stream_fence_windows_taskkill_root_report_version: 1,
        desktop_stream_fence_windows_taskkill_root_report: report,
      } as const)),
  };
}

/** Only the authorized command's exact unconfirmed-stop rejection, already
 * validated as both groups, can carry a fence origin. */
function refinesStopUnconfirmed(
  rejection: DesktopInvocationRejectionDiagnostic | null,
  unknown: DesktopInvocationUnknownDiagnostic | null,
): boolean {
  return (
    refinesAuthorizedUnknown(rejection) &&
    unknown?.desktop_invocation_unknown_version === 1 &&
    unknown.desktop_invocation_unknown_class === "lifecycle_stop_unconfirmed"
  );
}

/** The complete fence group, or null unless it refines a complete authorized
 * `lifecycle_stop_unconfirmed` rejection with a listed origin. Only an
 * `owner_stop_requested` or `owner_timeout` origin adds the complete cleanup
 * pair, for a listed failure; any other failure value leaves the origin pair
 * alone. Only either origin's `tree_unconfirmed` failure adds the complete
 * taskkill group, for a listed
 * outcome and valid code; anything else leaves both pairs alone. Only that
 * code adds a valid root report's pair; an invalid one drops alone. Only an
 * `owner_stop_requested` origin's report beside the not-found code, of either
 * class, adds a listed stop request source's pair; an invalid one, or any
 * beside `owner_timeout`, drops alone. Only an `owner_stop_requested`
 * origin's `tree_unconfirmed` failure without any taskkill argument adds the
 * complete Darwin stop group, for a listed source and probe class; anything
 * else drops alone. Only a `cancel_wait_timeout`
 * origin adds the complete owner phase pair, for a listed phase; any other
 * value leaves the origin pair alone. */
export function desktopStreamFenceDiagnostic(
  rejection: DesktopInvocationRejectionDiagnostic | null,
  unknown: DesktopInvocationUnknownDiagnostic | null,
  origin: unknown,
  cleanupFailure: unknown = null,
  windowsTaskkill: UncheckedWindowsTaskkill | null = null,
  cancelWaitOwnerPhase: unknown = null,
  stopRequestSource: unknown = null,
  darwinStop: {
    readonly source: unknown;
    readonly groupProbe: unknown;
  } | null = null,
): DesktopStreamFenceDiagnostic | null {
  if (!refinesStopUnconfirmed(rejection, unknown)) return null;
  const known = STREAM_FENCE_ORIGINS.find((value) => value === origin);
  if (!known) return null;
  if (known === STREAM_FENCE_OWNER_PHASE_ORIGIN) {
    const phase = STREAM_FENCE_CANCEL_WAIT_OWNER_PHASES.find(
      (value) => value === cancelWaitOwnerPhase,
    );
    const timedOut = {
      desktop_stream_fence_version: 1,
      desktop_stream_fence_origin: known,
    } as const;
    return Object.freeze(
      phase
        ? {
            ...timedOut,
            desktop_stream_fence_cancel_wait_owner_phase_version: 1 as const,
            desktop_stream_fence_cancel_wait_owner_phase: phase,
          }
        : timedOut,
    );
  }
  const failure = carriesCleanup(known)
    ? STREAM_FENCE_CLEANUP_FAILURES.find((value) => value === cleanupFailure)
    : undefined;
  const taskkill =
    carriesWindowsTaskkill(known, failure) && windowsTaskkill
      ? windowsTaskkillGroup(
          windowsTaskkill.outcome,
          windowsTaskkill.exitCode,
          windowsTaskkill.rootReport,
        )
      : null;
  const source =
    taskkill &&
    carriesStopRequestSource(
      known,
      taskkill.desktop_stream_fence_windows_taskkill_root_report,
      taskkill.desktop_stream_fence_windows_taskkill_exit_code,
    )
      ? STREAM_FENCE_STOP_REQUEST_SOURCES.find(
          (value) => value === stopRequestSource,
        )
      : undefined;
  // Platform-exclusive: never beside a taskkill argument, valid or not.
  const darwin =
    !windowsTaskkill && darwinStop && carriesDarwinStop(known, failure)
      ? darwinStopGroup(darwinStop.source, darwinStop.groupProbe)
      : null;
  const pair = {
    desktop_stream_fence_version: 1,
    desktop_stream_fence_origin: known,
  } as const;
  if (!failure) return Object.freeze(pair);
  const cleanup = {
    ...pair,
    desktop_stream_fence_cleanup_version: 1,
    desktop_stream_fence_cleanup_failure: failure,
  } as const;
  if (darwin) return Object.freeze({ ...cleanup, ...darwin });
  return Object.freeze(
    taskkill
      ? {
          ...cleanup,
          ...taskkill,
          ...(source &&
            ({
              desktop_stream_fence_stop_request_source_version: 1,
              desktop_stream_fence_stop_request_source: source,
            } as const)),
        }
      : cleanup,
  );
}

/** Own data values of `keys` on any property bag; a missing key or accessor
 * reads as undefined. A getter never runs; a throw propagates. */
function ownDataValuesOrUndefined(
  source: object,
  keys: readonly string[],
): unknown[] {
  return keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  });
}

/** For an `owner_timeout` group, whether `source` still holds exactly its
 * validated origin and cleanup pairs, which reading a later group can change
 * on a proxy; every other origin keeps its existing checks. A getter never
 * runs; a throw propagates. */
function timeoutPairsUnchanged(
  source: object,
  fence: DesktopStreamFenceDiagnostic,
): boolean {
  if (fence.desktop_stream_fence_origin !== STREAM_FENCE_TIMEOUT_ORIGIN)
    return true;
  // On a proxy, reading either pair can change the other: the cleanup pair is
  // read on both sides of the origin pair.
  const unchanged = (keys: readonly (keyof DesktopStreamFenceDiagnostic)[]) => {
    const values = ownDataValuesOrUndefined(source, keys);
    return keys.every((key, index) => values[index] === fence[key]);
  };
  return (
    unchanged(STREAM_FENCE_CLEANUP_PROPERTIES) &&
    unchanged(STREAM_FENCE_PROPERTIES) &&
    unchanged(STREAM_FENCE_CLEANUP_PROPERTIES)
  );
}

/** Whether `source` has none of `keys` as an own property of any kind. A
 * getter never runs; a throw propagates. */
function lacksOwnProperties(source: object, keys: readonly string[]): boolean {
  return keys.every(
    (key) => Object.getOwnPropertyDescriptor(source, key) === undefined,
  );
}

/** `cleaned` with the Darwin stop group read from the same property bag,
 * only beside its validated `owner_stop_requested` origin and
 * `tree_unconfirmed` cleanup pairs and without any taskkill group property.
 * An invalid group, or one whose read changed those pairs or added a taskkill
 * group property, drops alone. A getter never runs; a throw keeps `cleaned`. */
function readDarwinStop(
  source: object,
  rejection: DesktopInvocationRejectionDiagnostic | null,
  unknown: DesktopInvocationUnknownDiagnostic | null,
  cleaned: DesktopStreamFenceDiagnostic,
): DesktopStreamFenceDiagnostic {
  if (
    !carriesDarwinStop(
      cleaned.desktop_stream_fence_origin,
      cleaned.desktop_stream_fence_cleanup_failure,
    )
  )
    return cleaned;
  try {
    if (!lacksOwnProperties(source, STREAM_FENCE_WINDOWS_ONLY_PROPERTIES))
      return cleaned;
    const [version, stopSource, groupProbe] = ownDataValuesOrUndefined(
      source,
      STREAM_FENCE_DARWIN_STOP_PROPERTIES,
    );
    if (version !== 1) return cleaned;
    // Reading the group can change earlier properties on a proxy. Keep the
    // validated pairs unless they, the group version and the absence of
    // every Windows-only property all still hold.
    const fenceKeys = [
      ...STREAM_FENCE_PROPERTIES,
      ...STREAM_FENCE_CLEANUP_PROPERTIES,
    ] as const;
    const rechecked = ownDataValuesOrUndefined(source, [
      ...fenceKeys,
      STREAM_FENCE_DARWIN_STOP_PROPERTIES[0],
    ]);
    if (
      !fenceKeys.every((key, index) => rechecked[index] === cleaned[key]) ||
      rechecked.at(-1) !== version ||
      !lacksOwnProperties(source, STREAM_FENCE_WINDOWS_ONLY_PROPERTIES)
    )
      return cleaned;
    return (
      desktopStreamFenceDiagnostic(
        rejection,
        unknown,
        cleaned.desktop_stream_fence_origin,
        cleaned.desktop_stream_fence_cleanup_failure,
        null,
        null,
        null,
        { source: stopSource, groupProbe },
      ) ?? cleaned
    );
  } catch {
    return cleaned;
  }
}

/** Read the complete fence group from any property bag's own data properties,
 * joined to already validated authorized `unknown` and
 * `lifecycle_stop_unconfirmed` groups, or nothing at all. No property is read
 * without them. The cleanup pair is read only beside a validated
 * `owner_stop_requested` or `owner_timeout` origin on an acknowledged
 * terminal, and an invalid one, or an `owner_timeout` one whose read changed
 * the validated fence pair, drops alone. The taskkill group is read only
 * beside either origin's validated `tree_unconfirmed` cleanup pair, and an
 * invalid one, including a code beside `output_error` or an accessor code, or
 * an `owner_timeout` one whose read changed the validated pairs, drops alone.
 * The root report pair is read only beside a validated code, and an invalid
 * one, or an `owner_timeout` one whose read changed the validated pairs,
 * drops alone. The stop request source pair is read only beside an
 * `owner_stop_requested` origin's validated root report of the not-found code
 * from the same snapshot, and an invalid one drops alone; it is never read
 * beside `owner_timeout`. The Darwin stop group is read only beside a
 * validated `owner_stop_requested` origin's `tree_unconfirmed` cleanup pair
 * without any taskkill group property, and an invalid one drops alone; it is
 * never read beside `owner_timeout`. The owner phase pair is read only beside a validated
 * `cancel_wait_timeout` origin on an acknowledged terminal, and an invalid one
 * drops alone. A getter never runs; a throwing proxy reads as nothing. */
export function readDesktopStreamFenceDiagnostic(
  source: unknown,
  rejection: DesktopInvocationRejectionDiagnostic | null,
  unknown: DesktopInvocationUnknownDiagnostic | null,
  terminalAcknowledged = false,
): DesktopStreamFenceDiagnostic | null {
  if (
    !refinesStopUnconfirmed(rejection, unknown) ||
    typeof source !== "object" ||
    source === null
  )
    return null;
  let fence: DesktopStreamFenceDiagnostic | null;
  try {
    const [version, origin] = ownDataValuesOrUndefined(
      source,
      STREAM_FENCE_PROPERTIES,
    );
    fence =
      version === 1
        ? desktopStreamFenceDiagnostic(rejection, unknown, origin)
        : null;
  } catch {
    return null;
  }
  if (
    fence &&
    terminalAcknowledged &&
    fence.desktop_stream_fence_origin === STREAM_FENCE_OWNER_PHASE_ORIGIN
  ) {
    try {
      const [version, phase] = ownDataValuesOrUndefined(
        source,
        STREAM_FENCE_OWNER_PHASE_PROPERTIES,
      );
      return version === 1
        ? (desktopStreamFenceDiagnostic(
            rejection,
            unknown,
            fence.desktop_stream_fence_origin,
            null,
            null,
            phase,
          ) ?? fence)
        : fence;
    } catch {
      return fence;
    }
  }
  if (
    !fence ||
    !terminalAcknowledged ||
    !carriesCleanup(fence.desktop_stream_fence_origin)
  )
    return fence;
  let cleaned: DesktopStreamFenceDiagnostic | null;
  try {
    const [version, failure] = ownDataValuesOrUndefined(
      source,
      STREAM_FENCE_CLEANUP_PROPERTIES,
    );
    cleaned =
      version === 1
        ? desktopStreamFenceDiagnostic(
            rejection,
            unknown,
            fence.desktop_stream_fence_origin,
            failure,
          )
        : fence;
    // Reading the cleanup can change the fence on a proxy: a timeout's
    // cleanup joins only the exact origin pair validated above.
    if (
      cleaned?.desktop_stream_fence_cleanup_failure !== undefined &&
      fence.desktop_stream_fence_origin === STREAM_FENCE_TIMEOUT_ORIGIN
    ) {
      const [fenceVersion, fenceOrigin] = ownDataValuesOrUndefined(
        source,
        STREAM_FENCE_PROPERTIES,
      );
      if (
        fenceVersion !== fence.desktop_stream_fence_version ||
        fenceOrigin !== fence.desktop_stream_fence_origin
      )
        return fence;
    }
  } catch {
    return fence;
  }
  if (
    !cleaned ||
    !carriesWindowsTaskkill(
      cleaned.desktop_stream_fence_origin,
      cleaned.desktop_stream_fence_cleanup_failure,
    )
  )
    return cleaned;
  let taskkill: DesktopStreamFenceDiagnostic;
  try {
    const [version, outcome] = ownDataValuesOrUndefined(
      source,
      STREAM_FENCE_TASKKILL_PROPERTIES,
    );
    // Without a taskkill group, only Darwin's own stop group can follow.
    if (version !== 1)
      return readDarwinStop(source, rejection, unknown, cleaned);
    // An absent code is no code; a present one must be a valid data value.
    const code = Object.getOwnPropertyDescriptor(
      source,
      STREAM_FENCE_TASKKILL_EXIT_CODE_PROPERTY,
    );
    if (code && (!("value" in code) || code.value === undefined))
      return cleaned;
    // An invalid group leaves exactly the validated pairs.
    taskkill =
      desktopStreamFenceDiagnostic(
        rejection,
        unknown,
        cleaned.desktop_stream_fence_origin,
        cleaned.desktop_stream_fence_cleanup_failure,
        { outcome, exitCode: code?.value },
      ) ?? cleaned;
    if (!timeoutPairsUnchanged(source, cleaned)) return cleaned;
  } catch {
    return cleaned;
  }
  // The root report pair is read only beside a validated code, and an
  // invalid one, including `requested_pid_not_found` beside another code,
  // drops alone.
  const exitCode = taskkill.desktop_stream_fence_windows_taskkill_exit_code;
  if (exitCode === undefined) return taskkill;
  const taskkillOutcome =
    taskkill.desktop_stream_fence_windows_taskkill_outcome;
  let reported: DesktopStreamFenceDiagnostic;
  try {
    const [version, rootReport] = ownDataValuesOrUndefined(
      source,
      STREAM_FENCE_TASKKILL_ROOT_REPORT_PROPERTIES,
    );
    if (version !== 1) return taskkill;
    // The report joins only the taskkill snapshot validated above: a group
    // that changed, vanished or became an accessor meanwhile keeps only that
    // earlier snapshot.
    const [taskkillVersion, outcome, code] = ownDataValuesOrUndefined(source, [
      ...STREAM_FENCE_TASKKILL_PROPERTIES,
      STREAM_FENCE_TASKKILL_EXIT_CODE_PROPERTY,
    ]);
    if (
      taskkillVersion !== 1 ||
      outcome !== taskkillOutcome ||
      code !== exitCode ||
      !timeoutPairsUnchanged(source, taskkill)
    )
      return taskkill;
    reported =
      desktopStreamFenceDiagnostic(
        rejection,
        unknown,
        taskkill.desktop_stream_fence_origin,
        taskkill.desktop_stream_fence_cleanup_failure,
        { outcome: taskkillOutcome, exitCode, rootReport },
      ) ?? taskkill;
  } catch {
    return taskkill;
  }
  // The stop request source pair is read only beside an explicit stop's
  // validated root report of the not-found code, and an invalid one drops
  // alone; a timeout's never is.
  const rootReport = reported.desktop_stream_fence_windows_taskkill_root_report;
  if (
    !carriesStopRequestSource(
      reported.desktop_stream_fence_origin,
      rootReport,
      exitCode,
    )
  )
    return reported;
  try {
    const [version, stopRequestSource] = ownDataValuesOrUndefined(
      source,
      STREAM_FENCE_STOP_REQUEST_SOURCE_PROPERTIES,
    );
    if (version !== 1) return reported;
    // Reading the source can change earlier properties on a proxy. Keep the
    // already validated report unless the entire qualifying fence and the
    // source version still match.
    const fenceKeys = [
      ...STREAM_FENCE_PROPERTIES,
      ...STREAM_FENCE_CLEANUP_PROPERTIES,
      ...STREAM_FENCE_TASKKILL_PROPERTIES,
      STREAM_FENCE_TASKKILL_EXIT_CODE_PROPERTY,
      ...STREAM_FENCE_TASKKILL_ROOT_REPORT_PROPERTIES,
    ] as const;
    const rechecked = ownDataValuesOrUndefined(source, [
      ...fenceKeys,
      STREAM_FENCE_STOP_REQUEST_SOURCE_PROPERTIES[0],
    ]);
    if (
      !fenceKeys.every((key, index) => rechecked[index] === reported[key]) ||
      rechecked.at(-1) !== version
    )
      return reported;
    return (
      desktopStreamFenceDiagnostic(
        rejection,
        unknown,
        reported.desktop_stream_fence_origin,
        reported.desktop_stream_fence_cleanup_failure,
        { outcome: taskkillOutcome, exitCode, rootReport },
        null,
        stopRequestSource,
      ) ?? reported
    );
  } catch {
    return reported;
  }
}

/** Only a validated `cancel_ipc` first stop request source, which only an
 * acknowledged Windows Desktop terminal carries, of a command without a
 * Trigger run ID can carry the renderer cancel attempt pair. */
function carriesRendererCancelAttempt(
  fence: DesktopStreamFenceDiagnostic | null,
  runless: boolean,
): fence is DesktopStreamFenceDiagnostic {
  return (
    runless && fence?.desktop_stream_fence_stop_request_source === "cancel_ipc"
  );
}

/** The complete renderer cancel attempt pair for a listed attempt, or null
 * unless it refines a validated runless `cancel_ipc` fence group. */
export function desktopStreamFenceRendererCancelDiagnostic(
  fence: DesktopStreamFenceDiagnostic | null,
  runless: boolean,
  attempt: unknown,
): DesktopStreamFenceRendererCancelDiagnostic | null {
  if (!carriesRendererCancelAttempt(fence, runless)) return null;
  const known = STREAM_FENCE_RENDERER_CANCEL_ATTEMPTS.find(
    (value) => value === attempt,
  );
  return known
    ? Object.freeze({
        desktop_stream_fence_renderer_cancel_attempt_version: 1,
        desktop_stream_fence_renderer_cancel_attempt: known,
      })
    : null;
}

/** Read the renderer cancel attempt pair from the property bag that `fence`
 * was validated from, or nothing at all. No property is read unless `fence`
 * holds a `cancel_ipc` source and the command is runless. An invalid pair, or
 * one whose read changed any validated fence property, drops alone. A getter
 * never runs; a throwing proxy reads as nothing. */
export function readDesktopStreamFenceRendererCancelDiagnostic(
  source: unknown,
  fence: DesktopStreamFenceDiagnostic | null,
  runless: boolean,
): DesktopStreamFenceRendererCancelDiagnostic | null {
  if (
    !carriesRendererCancelAttempt(fence, runless) ||
    typeof source !== "object" ||
    source === null
  )
    return null;
  try {
    const [version, attempt] = ownDataValuesOrUndefined(
      source,
      STREAM_FENCE_RENDERER_CANCEL_PROPERTIES,
    );
    if (version !== 1) return null;
    const fenceKeys = Object.keys(
      fence,
    ) as (keyof DesktopStreamFenceDiagnostic)[];
    const rechecked = ownDataValuesOrUndefined(source, [
      ...fenceKeys,
      STREAM_FENCE_RENDERER_CANCEL_PROPERTIES[0],
    ]);
    if (
      !fenceKeys.every((key, index) => rechecked[index] === fence[key]) ||
      rechecked.at(-1) !== version
    )
      return null;
    return desktopStreamFenceRendererCancelDiagnostic(fence, runless, attempt);
  } catch {
    return null;
  }
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
