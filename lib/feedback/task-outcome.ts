export const TASK_OUTCOME_FLAG = "task_outcome_feedback_v1";
export const TASK_OUTCOME_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const TASK_OUTCOME_EXPIRY_MS = 48 * 60 * 60 * 1000;
export const TASK_OUTCOME_READ_DELAY_MS = 15_000;
export const TASK_OUTCOME_ANSWERS = {
  yes: "Yes",
  partly: "Partly",
  no: "No",
  not_checked: "Haven’t checked yet",
} as const;
export type TaskOutcomeAnswer = keyof typeof TASK_OUTCOME_ANSWERS;
export const TASK_OUTCOME_REASONS = {
  solved_task: "Solved my task",
  useful_next_step: "Useful next step",
  clear_explanation: "Clear explanation",
  incorrect: "Incorrect result",
  did_not_work: "Didn’t work",
  missed_request: "Missed what I asked",
  incomplete: "Incomplete result",
  refusal: "Wouldn’t help with my task",
  tool_problem: "Tool or environment problem",
  other: "Other",
} as const;
export type TaskOutcomeReason = keyof typeof TASK_OUTCOME_REASONS;
export function reasonsForAnswer(
  answer: TaskOutcomeAnswer,
): TaskOutcomeReason[] {
  if (answer === "not_checked") return [];
  return answer === "yes"
    ? ["solved_task", "useful_next_step", "clear_explanation"]
    : [
        "incorrect",
        "did_not_work",
        "missed_request",
        "incomplete",
        "refusal",
        "tool_problem",
        "other",
      ];
}
