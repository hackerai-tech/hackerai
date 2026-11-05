import {
  contextFeedbackReadout,
  type ContextFeedbackObservation,
} from "../context-feedback-readout";
it("retains never-viewed and unchecked users, dedupes IDs, freezes outcomes and separates plans/phases/releases", () => {
  const row: ContextFeedbackObservation = {
    _id: "one",
    user_id: "u1",
    experiment_key: "agent_pro_context_v1",
    experiment_variant: "test",
    feedback_phase: "v1",
    release: "r1",
    selected_at: 1,
    expires_at: 20,
  };
  const solved = {
    ...row,
    answered_at: 5,
    answer: "solved" as const,
    viewed_at: 3,
    shown_at: 2,
  };
  const unchecked = {
    ...row,
    _id: "two",
    user_id: "u2",
    answered_at: 6,
    answer: "not_checked" as const,
  };
  const later = {
    ...row,
    _id: "three",
    user_id: "u3",
    answered_at: 30,
    answer: "solved" as const,
  };
  const result = contextFeedbackReadout(
    [
      solved,
      solved,
      unchecked,
      later,
      { ...row, _id: "four", user_id: "u4" },
      { ...solved, _id: "five", experiment_key: "agent_model_context_v1" },
      { ...solved, _id: "six", feedback_phase: "v2" },
      { ...solved, _id: "seven", release: "r2" },
    ],
    25,
  );
  expect(result).toHaveLength(4);
  expect(result[0]).toMatchObject({
    selected: 4,
    users: 4,
    claimed: 1,
    viewed: 1,
    answered: 2,
    assessed: 1,
    solved: 1,
    notChecked: 1,
    unanswered: 2,
    expiredUnanswered: 2,
    responseRate: 0.5,
    solvedPerSelected: 0.25,
    solvedPerAssessed: 1,
  });
  expect(JSON.stringify(result)).not.toContain("u1");
});
