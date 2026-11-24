import { v5 as uuidv5 } from "uuid";
import PostHogClient from "@/app/posthog";

/**
 * Server-side follow-up milestones for mid-run steering and the server queue
 * (HAC-270). The browser sends `queued_row_steered` and `queued_sent_now`
 * under the same event name.
 */
export type AgentFollowUpAction =
  /** A running Agent read steers before a model step. */
  | "steer_read"
  /** A finished run claimed the chat's next queued message. */
  | "queue_dispatch_claimed"
  /** The server started the next turn from a queued message. */
  | "queue_dispatch_started"
  /** The server left a claimed message for the user. */
  | "queue_dispatch_skipped"
  /** Starting the next turn failed. */
  | "queue_dispatch_failed";

export type QueueDispatchSkipReason =
  | "not_queued"
  | "settings_changed"
  | "entitlement_changed"
  | "chat_unavailable";

type FollowUpContext = {
  userId: string;
  chatId: string;
  runId?: string;
  subscription?: string;
  steerCount?: number;
  skipReason?: QueueDispatchSkipReason;
  /** Time from first queuing to the server start, on the sender's clock. */
  queuedForMs?: number;
  fromSteer?: boolean;
  /** For queue_dispatch_failed: before Trigger returned a run, or after. */
  failurePhase?: "start" | "attach";
  /** Distinguishes events that share a run, such as several steer reads. */
  dedupeKey?: string;
};

/** Counts, enums and IDs only; never message text. Never throws. */
export async function captureAgentFollowUp(
  action: AgentFollowUpAction,
  context: FollowUpContext,
) {
  let client: ReturnType<typeof PostHogClient> = null;
  try {
    client = PostHogClient();
    if (!client) return;
    client.capture({
      distinctId: context.userId,
      event: "agent_follow_up",
      uuid: uuidv5(
        JSON.stringify([
          action,
          context.chatId,
          context.runId,
          context.dedupeKey,
        ]),
        uuidv5.URL,
      ),
      properties: {
        telemetry_version: 1,
        action,
        chat_id: context.chatId,
        trigger_run_id: context.runId,
        subscription: context.subscription,
        steer_count: context.steerCount,
        skip_reason: context.skipReason,
        queued_for_ms:
          context.queuedForMs !== undefined && context.queuedForMs >= 0
            ? context.queuedForMs
            : undefined,
        from_steer: context.fromSteer,
        failure_phase: context.failurePhase,
        $geoip_disable: true,
        $process_person_profile: false,
      },
    });
  } catch {
    console.warn("Follow-up analytics capture failed", { action });
  } finally {
    try {
      // Bounded so an analytics outage cannot hold up a run or dispatch.
      await client?.shutdown(1000);
    } catch {
      // Delivery failures are non-fatal.
    }
  }
}
