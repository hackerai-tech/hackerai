import { v } from "convex/values";
import {
  ABLITERATED_EXPERIMENT_KEY,
  FREE_ASK_ABLITERATED_EXPERIMENT_KEY,
} from "../lib/experiments/abliteration-keys";
export const taskOutcomeAnswer = v.union(
  v.literal("yes"),
  v.literal("partly"),
  v.literal("no"),
  v.literal("not_checked"),
);
export const taskOutcomeReason = v.union(
  v.literal("solved_task"),
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
  request_id: v.string(),
  chat_id: v.string(),
  message_id: v.string(),
  // Older reservations belong to the original paid/free Agent experiment.
  experiment_key: v.optional(
    v.union(
      v.literal(ABLITERATED_EXPERIMENT_KEY),
      v.literal(FREE_ASK_ABLITERATED_EXPERIMENT_KEY),
    ),
  ),
  experiment_variant: v.union(v.literal("control"), v.literal("test")),
  baseline_model: v.string(),
  assigned_model: v.string(),
  mode: v.union(v.literal("ask"), v.literal("agent")),
  subscription_tier: v.string(),
  release: v.string(),
  // Optional for surveys reserved by older deployed clients/workers.
  routing_version: v.optional(v.string()),
  generation_step_limit: v.optional(v.number()),
};
export const taskOutcomeFields = {
  ...taskOutcomeContext,
  user_id: v.string(),
  selected_at: v.number(),
  expires_at: v.number(),
  last_interaction_at: v.number(),
  shown_at: v.optional(v.number()),
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
