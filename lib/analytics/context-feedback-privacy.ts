// Filter after SDK enrichment. Invitation/answer events must not acquire URLs,
// campaign fields, registered content or person-property envelopes.
const ALLOWED_PROPERTIES = new Set([
  "token",
  "distinct_id",
  "$session_id",
  "$window_id",
  "$is_identified",
  "$insert_id",
  "$process_person_profile",
  "$lib",
  "$lib_version",
  "survey_key",
  "survey_version",
  "survey_ui_version",
  "survey_kind",
  "survey_request_id",
  "selected_at",
  "expires_at",
  "experiment_key",
  "experiment_variant",
  "experiment_request_id",
  "selected_model_override",
  "feedback_phase",
  "trigger_run_id",
  "source_history_chars",
  "source_has_prior_summary",
  "task_solved",
  "message_id",
  "chat_id",
  "mode",
  "subscription_tier",
  "release",
  "answer",
  "reason",
  "hackerai_frontend_build_commit",
]);
export function sanitizeContextFeedbackEvent<
  T extends {
    event?: string;
    properties?: Record<string, unknown>;
    $set?: unknown;
    $set_once?: unknown;
  },
>(event: T): T {
  if (
    !event.event?.startsWith("task_outcome_survey_") ||
    event.properties?.survey_kind !== "agent_context"
  )
    return event;
  event.properties = Object.fromEntries(
    Object.entries(event.properties).filter(([key]) =>
      ALLOWED_PROPERTIES.has(key),
    ),
  );
  delete event.$set;
  delete event.$set_once;
  return event;
}
