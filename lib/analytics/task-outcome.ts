import { TASK_OUTCOME_FLAG } from "../feedback/task-outcome";
import {
  ABLITERATED_EXPERIMENT_KEY,
  type AbliterationExperimentKey,
} from "../experiments/abliteration-keys";

/** Shared allowlist: never pass the full database row or user content to PostHog. */
export function taskOutcomeProperties(row: {
  request_id: string;
  message_id: string;
  chat_id: string;
  experiment_variant: string;
  experiment_key?: AbliterationExperimentKey;
  baseline_model: string;
  assigned_model: string;
  mode: string;
  subscription_tier: string;
  release: string;
  routing_version?: string;
  generation_step_limit?: number;
  answer?: string;
  reason?: string;
}) {
  return {
    survey_key: TASK_OUTCOME_FLAG,
    survey_version: 1,
    // Legacy reservations were created under the three-step policy. Never
    // relabel them with the limit of a newer frontend deployment.
    routing_version: row.routing_version ?? "first_three_generation_steps_v1",
    generation_step_limit: row.generation_step_limit ?? 3,
    experiment_key: row.experiment_key ?? ABLITERATED_EXPERIMENT_KEY,
    experiment_variant: row.experiment_variant,
    experiment_request_id: row.request_id,
    message_id: row.message_id,
    chat_id: row.chat_id,
    baseline_model: row.baseline_model,
    assigned_model: row.assigned_model,
    mode: row.mode,
    subscription_tier: row.subscription_tier,
    release: row.release,
    ...(row.answer && { answer: row.answer }),
    ...(row.reason && { reason: row.reason }),
    $process_person_profile: false,
  };
}
