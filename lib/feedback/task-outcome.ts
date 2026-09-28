export const PAID_TASK_OUTCOME_FLAG = "paid_task_outcome_feedback_v1";
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
