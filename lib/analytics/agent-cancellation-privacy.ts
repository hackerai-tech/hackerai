import { projectCancellationResponseReceipt } from "@/lib/agent-cancellation-response";

// Applied after SDK enrichment, so registered properties and URLs cannot leak.
const ALLOWED_PROPERTIES = new Set([
  "token",
  "distinct_id",
  "$session_id",
  "$window_id",
  "$is_identified",
  "$process_person_profile",
  "$lib",
  "$lib_version",
  "schemaVersion",
  "cancellationId",
  "chatId",
  "triggerRunId",
  "action",
  "reason",
  "outcome",
  "durationMs",
  "hackerai_frontend_build_commit",
]);

const STOP_SNAPSHOT_PROPERTIES = new Set([
  "token",
  "distinct_id",
  "$session_id",
  "$window_id",
  "$is_identified",
  "$process_person_profile",
  "$lib",
  "$lib_version",
  "diagnostic_version",
  "preparation_outcome",
  "before_size_bytes",
  "after_size_bytes",
  "part_count",
  "pruned_count",
  "save_outcome",
  "save_error_code",
  "convex_request_id",
  "frontend_build_commit",
]);

/** Strip SDK-enriched private context from cancellation and Stop diagnostics. */
export function sanitizeAgentCancellationEvent<
  T extends {
    event?: string;
    properties?: Record<string, unknown>;
    $set?: unknown;
    $set_once?: unknown;
  },
>(event: T): T {
  const allowedProperties =
    event.event === "chat_stop_snapshot_save_outcome"
      ? STOP_SNAPSHOT_PROPERTIES
      : event.event === "agent_run_cancellation_requested" ||
          event.event === "agent_run_cancellation_settled"
        ? ALLOWED_PROPERTIES
        : undefined;
  if (!allowedProperties) return event;
  if (event.properties) {
    // Project before filtering, from own data properties only: a failed
    // settlement may carry its validated v1 response receipt, nothing else.
    const receipt =
      event.event === "agent_run_cancellation_settled" &&
      Object.getOwnPropertyDescriptor(event.properties, "outcome")?.value ===
        "error"
        ? projectCancellationResponseReceipt(event.properties)
        : undefined;
    event.properties = {
      ...Object.fromEntries(
        Object.entries(event.properties).filter(([key]) =>
          allowedProperties.has(key),
        ),
      ),
      ...receipt,
    };
  }
  delete event.$set;
  delete event.$set_once;
  return event;
}
