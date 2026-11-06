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
  "frontend_build_commit",
]);

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
    event.properties = Object.fromEntries(
      Object.entries(event.properties).filter(([key]) =>
        allowedProperties.has(key),
      ),
    );
  }
  delete event.$set;
  delete event.$set_once;
  return event;
}
