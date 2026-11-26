import type { LocalStopReason } from "./local-connection-stop";
import { environmentPreference } from "../sandbox/environment";

/**
 * Automatic continuation of a Desktop Agent run after its own computer comes
 * back (HAC-275). A stop is continued at most once, by the server, through
 * the same start route and resume context as a manual Resume. Shared by the
 * Convex decision record and the Node callers so both apply one policy.
 */

/** A stop older than this keeps the manual Resume prompt. */
export const LOCAL_AUTO_CONTINUE_MAX_STOP_AGE_MS = 30 * 60_000;
/** At most this many automatic starts per chat inside the window below. */
export const LOCAL_AUTO_CONTINUE_CAP = 3;
export const LOCAL_AUTO_CONTINUE_CAP_WINDOW_MS = 5 * 60_000;
/**
 * A claimed start that never settled stops counting as in progress after this
 * long. It is never retried: the stop keeps the manual prompt, so a lost
 * response cannot become a second continuation.
 */
export const LOCAL_AUTO_CONTINUE_START_LEASE_MS = 2 * 60_000;

export type LocalAutoContinueVariant = "control" | "test";

export const LOCAL_AUTO_CONTINUE_STATES = [
  /** Eligible; waiting for the same Desktop session to come back. */
  "awaiting_return",
  /** Never continues automatically; see the reason. */
  "ineligible",
  /** Came back in the control arm: the manual prompt stays. */
  "manual",
  /** Came back in the test arm after the chat's cap was reached. */
  "suppressed",
  /** The user acted before it continued. */
  "cancelled",
  /** Claimed by exactly one server start. */
  "starting",
  "started",
  "start_failed",
] as const;

export type LocalAutoContinueState =
  (typeof LOCAL_AUTO_CONTINUE_STATES)[number];

/** Closed, content-free reasons for every terminal state but `started`. */
export const LOCAL_AUTO_CONTINUE_REASONS = [
  // ineligible
  "intentional_stop",
  "session_replaced",
  "session_unverified",
  "session_unproven",
  "not_host_departure",
  "usage_limit",
  "stop_too_old",
  "account_deleting",
  // manual / suppressed
  "control",
  "cap",
  // cancelled
  "user_stop",
  "user_message",
  "manual_resume",
  "environment_switched",
  "chat_changed",
  "superseded",
  // start_failed
  "admission_refused",
  "start_error",
] as const;

export type LocalAutoContinueReason =
  (typeof LOCAL_AUTO_CONTINUE_REASONS)[number];

export type LocalAutoContinueCancelReason = Extract<
  LocalAutoContinueReason,
  "user_stop" | "user_message" | "manual_resume" | "environment_switched"
>;

/**
 * Stops that may end when the same session returns. An allowlist: a stop
 * reason added later stays manual until someone decides it is safe to continue
 * unattended. An unreconciled command is included: the continuation has the
 * same resume context as a manual Resume, which inspects the uncertain command
 * and never replays it, and users already resume most of these stops.
 */
const HOST_DEPARTURE_REASONS: ReadonlySet<LocalStopReason> = new Set([
  "selected_host_left",
  "selected_presence_absent",
  "selected_host_recovery_expired",
  "selected_connection_unavailable",
  "watched_connection_replaced",
  "desktop_command_unreconciled",
]);

const INELIGIBLE_STOP_REASONS: Partial<
  Record<LocalStopReason, LocalAutoContinueReason>
> = {
  // The Desktop announced a quit or sign-out.
  selected_host_ended: "intentional_stop",
  // Another launch or page now owns the computer, or never proved itself.
  desktop_session_replaced: "session_replaced",
  desktop_session_unverified: "session_unverified",
};

/** Whether a lost-connection stop may continue once its computer returns. */
export function localAutoContinueStopEligibility(
  stopReason: string | undefined,
): { eligible: true } | { eligible: false; reason: LocalAutoContinueReason } {
  const reason = stopReason as LocalStopReason | undefined;
  if (reason && HOST_DEPARTURE_REASONS.has(reason)) return { eligible: true };
  // Own properties only: "" or "constructor" must not map to a reason.
  const known =
    reason && Object.hasOwn(INELIGIBLE_STOP_REASONS, reason)
      ? INELIGIBLE_STOP_REASONS[reason]
      : undefined;
  return { eligible: false, reason: known ?? "not_host_departure" };
}

/**
 * The continuation's hidden user message ID. Derived from the stopped run, so
 * every retry saves the same message and the start route's dedupe key returns
 * the same Trigger run instead of a second one.
 */
export function localAutoContinueMessageId(stoppedRunId: string): string {
  // Never truncated: STOPPED_RUN_ID caps the run ID so this fits 128 chars,
  // and distinct runs always get distinct message IDs.
  return `local-auto-continue-${stoppedRunId}`;
}

/**
 * The continuation's sandbox: exactly the computer whose session came back.
 * A generic "desktop" preference would let the run pick whichever Desktop is
 * newest, so it is narrowed to that computer. Undefined when the stopped run
 * cannot be bound to it: then the stop never continues automatically.
 */
export function localAutoContinueSandboxPreference(
  stoppedPreference: string | undefined,
  environmentId: string | undefined,
): string | undefined {
  if (!environmentId) return undefined;
  const bound = environmentPreference({
    connectionId: "",
    environmentId,
    isDesktop: true,
  });
  return stoppedPreference === "desktop" || stoppedPreference === bound
    ? bound
    : undefined;
}

/** Trigger run IDs, as the start route and analytics accept them. */
export const STOPPED_RUN_ID = /^[A-Za-z0-9_-]{1,108}$/;

/** Whether the chat's recent automatic starts leave room for one more. */
export function localAutoContinueCapAllows(
  recentStartTimes: readonly number[],
  now: number,
): boolean {
  const windowStart = now - LOCAL_AUTO_CONTINUE_CAP_WINDOW_MS;
  return (
    recentStartTimes.filter((time) => time > windowStart).length <
    LOCAL_AUTO_CONTINUE_CAP
  );
}
