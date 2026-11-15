import type { IsolatedOperationPhase } from "./dispatch-operation";

type ReceiverState = {
  sequence: number;
  terminalReceived: boolean;
  cancelRequested: boolean;
  dispatched: boolean;
};

export type ReceiverCleanupReason =
  | "terminal_ack_published"
  | "legacy_terminal"
  | "canceled"
  | "cancel_failed"
  | "deadline"
  | "output_unavailable"
  | "unsequenced_error"
  | "sequence_gap"
  | "recovery_incomplete"
  | "subscription_error"
  | "unsubscribed"
  | "presence_missing"
  | "dispatch_failed"
  | "disconnected"
  | "client_error";

/** Which wait timed out after command publication started. */
export type DispatchUncertainReason =
  "publish_timeout" | "operation_ready_timeout";

/** Server-side, content-free counterpart to Desktop sender settlement telemetry.
 * A published cursor proves broker acceptance, not receipt by the sender.
 * Bound transition logs independently of retries; always retain final counters.
 */
export function createReceiverDiagnostics(
  context: {
    commandId: string;
    triggerRunId?: string;
    enabled: boolean;
    /** What the server asked Desktop to do; not the native lifetime or receipt. */
    requestedBackground?: boolean;
    /** Requested execution budget, excluding any receiver delivery allowance. */
    requestedTimeoutMs?: number;
  },
  state: () => ReceiverState,
) {
  const started = Date.now();
  let startRecorded = false;
  // Closed group: omitted entirely unless both requested values are valid.
  const requestIntent = () => {
    try {
      const background: unknown = context.requestedBackground;
      const timeoutMs: unknown = context.requestedTimeoutMs;
      if (
        typeof background !== "boolean" ||
        typeof timeoutMs !== "number" ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0
      )
        return {};
      return {
        request_intent_version: 1,
        request_background: background,
        request_timeout_ms: timeoutMs,
      };
    } catch {
      return {};
    }
  };
  let transitions = 0;
  let suppressed = 0;
  let closed = false;
  let generation = 0;
  let ackAttempts = 0;
  let resumeAttempts = 0;
  let publishFailures = 0;
  let lastPublishedSequence = -1;
  let terminalType: "exit" | "error" | undefined;
  let cancelConfirmed: boolean | undefined;
  let lastPublishError: "timeout" | "other" | undefined;
  let dispatchPhase: IsolatedOperationPhase | "not_started" | "uncertain" =
    "not_started";
  let uncertainReason: DispatchUncertainReason | undefined;
  const uncertainty = () =>
    uncertainReason
      ? {
          dispatch_uncertain_version: 1,
          dispatch_uncertain_reason: uncertainReason,
        }
      : {};
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  const emit = (
    phase: string,
    details: Record<string, string | number | boolean | undefined> = {},
    final = false,
  ) => {
    if (!context.enabled || closed) return;
    if (!final && transitions++ >= 12) {
      suppressed++;
      return;
    }
    try {
      const s = state();
      console.info(
        JSON.stringify({
          event: "desktop_command_receiver",
          schema_version: 1,
          command_id: context.commandId,
          trigger_run_id: context.triggerRunId,
          phase,
          elapsed_ms: Date.now() - started,
          subscription_generation: generation,
          last_received_sequence: s.sequence,
          terminal_received: s.terminalReceived,
          cancel_requested: s.cancelRequested,
          command_dispatched: s.dispatched,
          last_published_sequence: lastPublishedSequence,
          ack_attempts: ackAttempts,
          resume_attempts: resumeAttempts,
          cursor_publish_failures: publishFailures,
          suppressed_transitions: suppressed,
          terminal_type: terminalType,
          cancel_confirmed: cancelConfirmed,
          last_cursor_publish_error: lastPublishError,
          ...details,
        }),
      );
    } catch {
      // Observability must not change command delivery or cleanup.
    }
  };
  return {
    start() {
      const first = !startRecorded;
      startRecorded = true;
      emit("started", first && context.enabled ? requestIntent() : {});
      if (context.enabled && !closed && !waitTimer) {
        // One passive snapshot before a web request's platform deadline.
        waitTimer = setTimeout(() => {
          emit("command_wait", {
            dispatch_phase: dispatchPhase,
            ...uncertainty(),
          });
        }, 10_000);
      }
    },
    dispatchPhase(phase: IsolatedOperationPhase) {
      dispatchPhase = phase;
    },
    subscribed(recovered: boolean) {
      generation++;
      emit("subscribed", { recovered });
    },
    transition(
      phase:
        | "subscribing"
        | "connected"
        | "cancel_requested"
        | "sequence_gap"
        | "subscription_retry"
        | "client_retry",
    ) {
      emit(phase);
    },
    dispatchUncertain(reason: DispatchUncertainReason) {
      dispatchPhase = "uncertain";
      uncertainReason = reason;
      emit("dispatch_uncertain", uncertainty());
    },
    cursorAttempt(resume: boolean) {
      if (resume) resumeAttempts++;
      else ackAttempts++;
    },
    terminal(type: "exit" | "error") {
      terminalType = type;
      emit("terminal_received");
    },
    cancelResult(confirmed: boolean) {
      cancelConfirmed = confirmed;
      emit("cancel_result");
    },
    cursorResult(
      resume: boolean,
      sequence: number,
      ok: boolean,
      timeout = false,
    ) {
      if (ok) lastPublishedSequence = Math.max(lastPublishedSequence, sequence);
      else {
        publishFailures++;
        lastPublishError = timeout ? "timeout" : "other";
      }
      // Routine prefix ACKs only update counters; retain failure/resume/terminal evidence.
      if (!ok || resume || state().terminalReceived)
        emit(ok ? "cursor_published" : "cursor_publish_failed", {
          cursor: resume ? "resume" : "ack",
          sequence,
        });
    },
    finish(reason: ReceiverCleanupReason) {
      clearTimeout(waitTimer);
      emit("cleanup", { reason, ...uncertainty() }, true);
      closed = true;
    },
  };
}
