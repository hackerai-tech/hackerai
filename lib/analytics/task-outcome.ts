import {
  PAID_TASK_OUTCOME_FLAG,
  TASK_OUTCOME_FLAG,
} from "../feedback/task-outcome";
import {
  ABLITERATED_EXPERIMENT_KEY,
  type AbliterationExperimentKey,
} from "../experiments/abliteration-keys";

/** Shared allowlist: never pass the full database row or user content to PostHog. */
export function taskOutcomeProperties(row: {
  request_id: string;
  message_id: string;
  chat_id: string;
  survey_kind?: "new_paid";
  experiment_variant?: string;
  experiment_key?: AbliterationExperimentKey;
  baseline_model?: string;
  assigned_model?: string;
  mode: string;
  subscription_tier: string;
  release: string;
  routing_version?: string;
  generation_step_limit?: number;
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
  const independent = row.survey_kind === "new_paid";
  return {
    survey_key: independent ? PAID_TASK_OUTCOME_FLAG : TASK_OUTCOME_FLAG,
    survey_version: independent ? 2 : 1,
    survey_kind: row.survey_kind ?? "model_experiment",
    survey_request_id: row.request_id,
    selected_at: row.selected_at,
    expires_at: row.expires_at,
    // Missing legacy keys identify the original experiment only for legacy rows.
    ...((!independent || row.experiment_key) && {
      routing_version: row.routing_version ?? "first_three_generation_steps_v1",
      generation_step_limit: row.generation_step_limit ?? 3,
      experiment_key: row.experiment_key ?? ABLITERATED_EXPERIMENT_KEY,
      experiment_variant: row.experiment_variant,
      experiment_request_id: row.request_id,
      baseline_model: row.baseline_model,
      assigned_model: row.assigned_model,
    }),
    ...(independent && {
      paid_started_at: row.paid_started_at,
      stripe_subscription_id: row.stripe_subscription_id,
      paid_start_invoice_id: row.paid_start_invoice_id,
      baseline_renewal_at: row.baseline_renewal_at,
      billing_interval: row.billing_interval,
      ...(row.answer && {
        task_solved:
          row.answer === "not_checked" ? null : row.answer === "solved",
      }),
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
