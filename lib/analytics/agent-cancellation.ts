import { v4 as uuidv4 } from "uuid";
import {
  captureQueuedAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
} from "./client";

export type AgentCancellationAction =
  "stop" | "stop_and_send" | "send_now" | "regenerate" | "retry" | "edit";
type CancellationResult = "accepted" | "stale_run" | "error";

/** Capture identity before awaiting a pending start; never attribute it to a later login. */
export function prepareAgentCancellationTelemetry(
  chatId: string,
  action: AgentCancellationAction,
) {
  let userId: string | null = null;
  try {
    userId = getIdentifiedAnalyticsUserId();
  } catch {
    // Diagnostics must never prevent Stop.
  }
  return (triggerRunId: string) => {
    const cancellationId = uuidv4();
    const startedAt = Date.now();
    const commit = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
    const properties = {
      schemaVersion: 1,
      cancellationId,
      chatId,
      triggerRunId,
      action,
      reason:
        action === "stop"
          ? "stop"
          : action === "stop_and_send" || action === "send_now"
            ? "steer"
            : "replace",
      ...(/^[a-f0-9]{40}$/i.test(commit ?? "") && {
        hackerai_frontend_build_commit: commit,
      }),
    };
    const capture = (event: string, fields: Record<string, unknown> = {}) => {
      try {
        if (!userId || getIdentifiedAnalyticsUserId() !== userId) return;
        captureQueuedAuthenticatedEvent({
          event,
          properties: { ...properties, ...fields },
          dedupeKey: cancellationId,
        });
      } catch {
        // Best effort; missing results remain unknown.
      }
    };
    capture("agent_run_cancellation_requested");
    let settled = false;
    return (outcome: CancellationResult) => {
      if (settled) return;
      settled = true;
      capture("agent_run_cancellation_settled", {
        outcome,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    };
  };
}
