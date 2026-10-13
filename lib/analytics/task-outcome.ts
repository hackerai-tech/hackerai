import {
  EXPERIMENT_TASK_OUTCOME_FLAG,
  PAID_TASK_OUTCOME_FLAG,
} from "../feedback/task-outcome";

/** Shared allowlist: never pass the full database row or user content to PostHog. */
export function taskOutcomeProperties(row: {
  request_id: string;
  message_id: string;
  chat_id: string;
  survey_kind: "new_paid" | "model_experiment" | "current_experiment";
  experiment_key?: string;
  experiment_variant?: string;
  experiment_request_id?: string;
  selected_model_override?: string;
  assigned_model?: string;
  baseline_model?: string;
  feedback_phase?: string;
  mode: string;
  subscription_tier: string;
  release: string;
  paid_started_at?: number;
  stripe_subscription_id?: string;
  paid_start_invoice_id?: string;
  baseline_renewal_at?: number;
  billing_interval?: string;
  selected_at?: number;
  expires_at?: number;
  answer?: string;
  reason?: string;
}) {
  return {
    survey_key:
      row.survey_kind === "current_experiment"
        ? EXPERIMENT_TASK_OUTCOME_FLAG
        : PAID_TASK_OUTCOME_FLAG,
    survey_version: row.survey_kind === "current_experiment" ? 3 : 2,
    ...(row.survey_kind === "current_experiment" && {
      experiment_key: row.experiment_key,
      experiment_variant: row.experiment_variant,
      experiment_request_id: row.experiment_request_id,
      selected_model_override: row.selected_model_override,
      assigned_model: row.assigned_model,
      baseline_model: row.baseline_model,
      feedback_phase: row.feedback_phase,
    }),
    survey_kind: row.survey_kind,
    survey_request_id: row.request_id,
    selected_at: row.selected_at,
    expires_at: row.expires_at,
    paid_started_at: row.paid_started_at,
    stripe_subscription_id: row.stripe_subscription_id,
    paid_start_invoice_id: row.paid_start_invoice_id,
    baseline_renewal_at: row.baseline_renewal_at,
    billing_interval: row.billing_interval,
    ...(row.answer && {
      task_solved:
        row.answer === "not_checked" ? null : row.answer === "solved",
    }),
    message_id: row.message_id,
    chat_id: row.chat_id,
    mode: row.mode,
    subscription_tier: row.subscription_tier,
    release: row.release,
    ...(row.answer && { answer: row.answer }),
    ...(row.reason && { reason: row.reason }),
    $process_person_profile: false,
  };
}
