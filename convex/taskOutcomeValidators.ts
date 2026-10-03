import { v } from "convex/values";
import { ABLITERATED_MAX_EXPERIMENT_KEY } from "../lib/experiments/abliteration-keys";
import { EXPERIMENT_TASK_OUTCOME_PHASE } from "../lib/feedback/task-outcome";
export const taskOutcomeAnswer = v.union(
  v.literal("solved"),
  v.literal("helpful"),
  v.literal("no"),
  v.literal("not_checked"),
);
export const taskOutcomeReason = v.union(
  v.literal("useful_next_step"),
  v.literal("clear_explanation"),
  v.literal("incorrect"),
  v.literal("did_not_work"),
  v.literal("missed_request"),
  v.literal("incomplete"),
  v.literal("refusal"),
  v.literal("tool_problem"),
  v.literal("other"),
);
export const taskOutcomeContext = {
  survey_kind: v.literal("new_paid"),
  request_id: v.string(),
  chat_id: v.string(),
  message_id: v.string(),
  mode: v.union(v.literal("ask"), v.literal("agent")),
  subscription_tier: v.string(),
  release: v.string(),
};
export const experimentTaskOutcomeContext = {
  ...taskOutcomeContext,
  survey_kind: v.literal("current_experiment"),
  experiment_key: v.literal(ABLITERATED_MAX_EXPERIMENT_KEY),
  experiment_variant: v.union(v.literal("control"), v.literal("test")),
  experiment_request_id: v.string(),
  selected_model_override: v.union(
    v.literal("hackerai-pro"),
    v.literal("hackerai-max"),
  ),
  assigned_model: v.string(),
  baseline_model: v.string(),
  feedback_phase: v.literal(EXPERIMENT_TASK_OUTCOME_PHASE),
};
export const taskOutcomeFields = {
  ...taskOutcomeContext,
  survey_kind: v.union(
    v.literal("new_paid"),
    v.literal("model_experiment"),
    v.literal("current_experiment"),
  ),
  user_id: v.string(),
  // Existing billing and historical attribution remain unchanged. Only the
  // new reservation endpoint requires current experiment context.
  experiment_key: v.optional(v.string()),
  experiment_variant: v.optional(v.string()),
  experiment_request_id: v.optional(v.string()),
  selected_model_override: v.optional(v.string()),
  assigned_model: v.optional(v.string()),
  baseline_model: v.optional(v.string()),
  feedback_phase: v.optional(v.string()),
  paid_start_event_id: v.optional(v.id("paid_start_events")),
  paid_started_at: v.optional(v.number()),
  stripe_subscription_id: v.optional(v.string()),
  paid_start_invoice_id: v.optional(v.string()),
  baseline_renewal_at: v.optional(v.number()),
  billing_interval: v.optional(v.string()),
  selected_at: v.number(),
  expires_at: v.number(),
  last_interaction_at: v.number(),
  shown_at: v.optional(v.number()),
  viewed_at: v.optional(v.number()),
  dismissed_at: v.optional(v.number()),
  answered_at: v.optional(v.number()),
  answer: v.optional(taskOutcomeAnswer),
  reason: v.optional(taskOutcomeReason),
};
export const taskOutcomeDocument = v.object({
  ...taskOutcomeFields,
  _id: v.id("task_outcome_surveys"),
  _creationTime: v.number(),
});
