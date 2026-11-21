/**
 * One native `cancel_stream_command` IPC that did not confirm the stop of an
 * original Windows Desktop command: it resolved strictly false (stop
 * unconfirmed, including a cancel wait timeout) or the IPC itself rejected.
 * Neither outcome describes any particular OS process. The single schema for
 * the capture and its before_send projection; dependency-free so both the
 * analytics client and the privacy guard can import it.
 */
export const DESKTOP_STREAM_CANCEL_NONCONFIRMATION_EVENT =
  "desktop_stream_cancel_nonconfirmation";
export const DESKTOP_STREAM_CANCEL_NONCONFIRMATION_VERSION = 1;

const CALLERS = [
  "relay_command_cancel",
  "output_overflow",
  "local_run_stop",
] as const;
const OUTCOMES = ["returned_false", "invoke_rejected"] as const;

export type DesktopStreamCancelCaller = (typeof CALLERS)[number];
export type DesktopStreamCancelOutcome = (typeof OUTCOMES)[number];

export type DesktopStreamCancelNonconfirmation = {
  version: typeof DESKTOP_STREAM_CANCEL_NONCONFIRMATION_VERSION;
  command_id: string;
  caller: DesktopStreamCancelCaller;
  outcome: DesktopStreamCancelOutcome;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Opaque account IDs (WorkOS user_...). Excludes URLs, emails and whitespace.
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isDesktopStreamCancelCommandId(
  value: unknown,
): value is string {
  return typeof value === "string" && value.length === 36 && UUID.test(value);
}

export function isDesktopStreamCancelOwner(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

/** Rebuild exactly the four fields; any missing or invalid one rejects all. */
export function projectDesktopStreamCancelNonconfirmation(
  read: (key: string) => unknown,
): DesktopStreamCancelNonconfirmation | null {
  const version = read("version");
  const commandId = read("command_id");
  const caller = read("caller");
  const outcome = read("outcome");
  if (version !== DESKTOP_STREAM_CANCEL_NONCONFIRMATION_VERSION) return null;
  if (!isDesktopStreamCancelCommandId(commandId)) return null;
  const knownCaller = CALLERS.find((known) => known === caller);
  const knownOutcome = OUTCOMES.find((known) => known === outcome);
  if (!knownCaller || !knownOutcome) return null;
  return {
    version,
    command_id: commandId,
    caller: knownCaller,
    outcome: knownOutcome,
  };
}
