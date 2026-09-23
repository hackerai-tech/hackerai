import { PAID_TASK_OUTCOME_FLAG } from "../feedback/task-outcome";

/** Shared allowlist: never pass the full database row or user content to PostHog. */
export function taskOutcomeProperties(row: {
  request_id: string;
  message_id: string;
  chat_id: string;
  survey_kind: "new_paid";
  mode: string;
  subscription_tier: string;
  release: string;
  paid_started_at: number;
  stripe_subscription_id: string;
  paid_start_invoice_id: string;
  baseline_renewal_at?: number;
  billing_interval?: string;
  selected_at?: number;
  expires_at?: number;
  answer?: string;
  reason?: string;
}) {
  return {
    survey_key: PAID_TASK_OUTCOME_FLAG,
    survey_version: 2,
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
