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

/** Server-side, content-free counterpart to Desktop sender settlement telemetry.
 * A published cursor proves broker acceptance, not receipt by the sender.
 * Bound transition logs independently of retries; always retain final counters.
 */
export function createReceiverDiagnostics(
  context: { commandId: string; triggerRunId?: string; enabled: boolean },
  state: () => ReceiverState,
) {
  const started = Date.now();
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
    start: () => emit("started"),
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
      emit("cleanup", { reason }, true);
      closed = true;
    },
  };
}
