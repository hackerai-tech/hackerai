import {
  ABLITERATED_EXPERIMENT_KEY,
  ABLITERATED_MAX_EXPERIMENT_KEY,
  ABLITERATED_PAID_FIRST_STEP_KEY,
  ABLITERATED_PAID_MODERATED_DEFAULT_KEY,
  ABLITERATED_PAID_THREE_STEPS_KEY,
  ABLITERATED_MODERATED_THREE_STEPS_DEFAULT_KEY,
} from "../experiments/abliteration-keys";
import type { AbliteratedAssignment } from "../experiments/abliterated-model";

export const PAID_TASK_OUTCOME_FLAG = "paid_task_outcome_feedback_v1";
// Feedback delivery is independent of the model's existing allocation.
export const EXPERIMENT_TASK_OUTCOME_FLAG =
  "abliterated_task_outcome_feedback_v1";
export const EXPERIMENT_TASK_OUTCOME_PHASE =
  "abliterated_max_moderated_feedback_v1";
export const PAID_FIRST_STEP_TASK_OUTCOME_PHASE =
  "abliterated_paid_first_step_feedback_v2";
export const PAID_MODERATED_TASK_OUTCOME_PHASE =
  "abliterated_paid_moderated_default_feedback_v1";

// Keep historical reservations readable while new assignments use their own
// immutable phase. A routing change must never relabel the old cohort.
export function experimentTaskOutcomePhase(key: AbliteratedAssignment["key"]) {
  switch (key) {
    case ABLITERATED_MAX_EXPERIMENT_KEY:
      return EXPERIMENT_TASK_OUTCOME_PHASE;
    case ABLITERATED_PAID_FIRST_STEP_KEY:
      return PAID_FIRST_STEP_TASK_OUTCOME_PHASE;
    case ABLITERATED_PAID_MODERATED_DEFAULT_KEY:
      return PAID_MODERATED_TASK_OUTCOME_PHASE;
    case ABLITERATED_EXPERIMENT_KEY:
    case ABLITERATED_PAID_THREE_STEPS_KEY:
    case ABLITERATED_MODERATED_THREE_STEPS_DEFAULT_KEY:
      // These routing policies measure operational outcomes; do not reuse an old
      // survey cohort or relabel its historical reservations.
      return undefined;
    default: {
      // A future routing phase must explicitly choose its feedback cohort.
      const unhandled: never = key;
      return unhandled;
    }
  }
}
export const NEW_PAID_SURVEY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const PAID_TASK_OUTCOME_ANSWERS = {
  solved: "Solved my task",
  helpful: "Helpful, still working",
  no: "Didn’t help",
  not_checked: "Haven’t checked",
} as const;
export const TASK_OUTCOME_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
export const TASK_OUTCOME_EXPIRY_MS = 48 * 60 * 60 * 1000;
export type TaskOutcomeAnswer = keyof typeof PAID_TASK_OUTCOME_ANSWERS;
export const TASK_OUTCOME_REASONS = {
  useful_next_step: "Useful next step",
  clear_explanation: "Clear explanation",
  incorrect: "Incorrect result",
  did_not_work: "Didn’t work",
  missed_request: "Missed what I asked",
  incomplete: "Incomplete result",
  refusal: "Refused to help",
  tool_problem: "Tool issue",
  other: "Other",
} as const;
export type TaskOutcomeReason = keyof typeof TASK_OUTCOME_REASONS;
export function reasonsForAnswer(
  answer: TaskOutcomeAnswer,
): TaskOutcomeReason[] {
  if (answer === "not_checked" || answer === "solved") return [];
  if (answer === "helpful") return ["useful_next_step", "clear_explanation"];
  return [
    "incorrect",
    "did_not_work",
    "missed_request",
    "incomplete",
    "refusal",
    "tool_problem",
    "other",
  ];
}
