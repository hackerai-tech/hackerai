/** One acknowledged stream command's rejected native invocation, as a closed
 * class of the fixed message the native app rejected it with, and the command
 * set the bridge selected for it. Never the message itself.
 *
 * A reason classifies the source message, not a physical stage, a cause or the
 * installed binary: the same message can arise more than one way. Every
 * message below has identical text in the desktop-v0.0.73 and desktop-v0.0.74
 * sources and in the current source; other releases were not inspected.
 * Anything else, including a changed message, a Tauri runtime error or a
 * frontend error, is `unknown`.
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

const MESSAGE_REASONS: ReadonlyMap<string, DesktopInvocationRejectionReason> =
  new Map([
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
    // execute_stream_command admission: update_safety.rs UpdateGate::operation,
    // command_stdin.rs decode and lib.rs spawn_stream_command.
    ["Desktop update state unavailable", "execution_admission"],
    [
      "Desktop is installing an update. Reopen the app before retrying.",
      "execution_admission",
    ],
    ["Command stdin exceeds limit", "execution_admission"],
    ["Invalid command stdin encoding", "execution_admission"],
    ["stream command state lock poisoned", "execution_admission"],
    ["Command is already running", "execution_admission"],
  ]);

// lib.rs spawn_stream_command; the OS error text after it is never read.
const SPAWN_PREFIX = "Failed to spawn: ";
const MAX_MESSAGE_LENGTH = 1024;

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

/** Tauri rejects with the native string. Otherwise only an Error's own data
 * `message` is read: never a getter, `toString` or other coercion. */
function rejectionMessage(error: unknown): string | null {
  if (typeof error === "string") return error;
  try {
    if (!(error instanceof Error)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    return descriptor &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

/** Never throws; anything but a listed message is `unknown`. */
export function classifyNativeInvocationRejection(
  error: unknown,
): DesktopInvocationRejectionReason {
  const message = rejectionMessage(error);
  if (message === null || message.length > MAX_MESSAGE_LENGTH) return "unknown";
  return (
    MESSAGE_REASONS.get(message) ??
    (message.startsWith(SPAWN_PREFIX) ? "spawn_failed" : "unknown")
  );
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
