import { v } from "convex/values";
import { AGENT_CONTEXT_FEEDBACK_PHASE } from "../lib/feedback/agent-context";
import {
  ABLITERATED_SHORT_FOLLOWUP_KEY,
  ABLITERATED_MAX_EXPERIMENT_KEY,
  ABLITERATED_PAID_FIRST_STEP_KEY,
  ABLITERATED_PAID_MODERATED_DEFAULT_KEY,
} from "../lib/experiments/abliteration-keys";
import {
  SHORT_FOLLOWUP_TASK_OUTCOME_PHASE,
  EXPERIMENT_TASK_OUTCOME_PHASE,
  PAID_FIRST_STEP_TASK_OUTCOME_PHASE,
  PAID_MODERATED_TASK_OUTCOME_PHASE,
} from "../lib/feedback/task-outcome";
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
  experiment_key: v.union(
    v.literal(ABLITERATED_SHORT_FOLLOWUP_KEY),
    v.literal(ABLITERATED_MAX_EXPERIMENT_KEY),
    v.literal(ABLITERATED_PAID_FIRST_STEP_KEY),
    v.literal(ABLITERATED_PAID_MODERATED_DEFAULT_KEY),
  ),
  experiment_variant: v.union(v.literal("control"), v.literal("test")),
  experiment_request_id: v.string(),
  selected_model_override: v.union(
    v.literal("auto"),
    v.literal("hackerai-standard"),
    v.literal("hackerai-pro"),
    v.literal("hackerai-max"),
  ),
  assigned_model: v.string(),
  baseline_model: v.string(),
  feedback_phase: v.union(
    v.literal(SHORT_FOLLOWUP_TASK_OUTCOME_PHASE),
    v.literal(EXPERIMENT_TASK_OUTCOME_PHASE),
    v.literal(PAID_FIRST_STEP_TASK_OUTCOME_PHASE),
    v.literal(PAID_MODERATED_TASK_OUTCOME_PHASE),
  ),
};
export const taskOutcomeFields = {
  ...taskOutcomeContext,
  survey_kind: v.union(
    v.literal("new_paid"),
    v.literal("model_experiment"),
    v.literal("current_experiment"),
    v.literal("agent_context"),
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
  trigger_run_id: v.optional(v.string()),
  source_history_chars: v.optional(v.number()),
  source_has_prior_summary: v.optional(v.boolean()),
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
  reason_at: v.optional(v.number()),
};
export const contextTaskOutcomeContext = {
  ...taskOutcomeContext,
  survey_kind: v.literal("agent_context"),
  mode: v.literal("agent"),
  experiment_key: v.union(
    v.literal("agent_model_context_v1"),
    v.literal("agent_pro_context_v1"),
  ),
  experiment_variant: v.union(v.literal("control"), v.literal("test")),
  selected_model_override: v.union(
    v.literal("hackerai-pro"),
    v.literal("hackerai-max"),
  ),
  feedback_phase: v.literal(AGENT_CONTEXT_FEEDBACK_PHASE),
  trigger_run_id: v.string(),
};
export const taskOutcomeDocument = v.object({
  ...taskOutcomeFields,
  _id: v.id("task_outcome_surveys"),
  _creationTime: v.number(),
});
