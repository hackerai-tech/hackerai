import { v } from "convex/values";
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
export const taskOutcomeFields = {
  ...taskOutcomeContext,
  user_id: v.string(),
  paid_start_event_id: v.id("paid_start_events"),
  paid_started_at: v.number(),
  stripe_subscription_id: v.string(),
  paid_start_invoice_id: v.string(),
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
