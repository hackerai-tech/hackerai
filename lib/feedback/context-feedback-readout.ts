import type { TaskOutcomeAnswer, TaskOutcomeReason } from "./task-outcome";

export type ContextFeedbackObservation = {
  _id: string;
  user_id: string;
  experiment_key?: string;
  experiment_variant?: string;
  feedback_phase?: string;
  release: string;
  selected_at: number;
  expires_at: number;
  shown_at?: number;
  viewed_at?: number;
  answered_at?: number;
  dismissed_at?: number;
  answer?: TaskOutcomeAnswer;
  reason?: TaskOutcomeReason;
  reason_at?: number;
};

/** Freeze interaction timestamps at asOf, then aggregate durable reservations.
 * Windows must be joined separately to actual context exposure/run outcomes.
 * No content is accepted, and no IDs are returned.
 */
export function contextFeedbackReadout(
  rows: readonly ContextFeedbackObservation[],
  asOf: number,
) {
  const deduped = new Map(
    rows.filter((r) => r.selected_at <= asOf).map((r) => [r._id, r]),
  );
  const groups = new Map<string, ContextFeedbackObservation[]>();
  for (const row of deduped.values()) {
    const key = JSON.stringify([
      row.experiment_key,
      row.experiment_variant,
      row.feedback_phase,
      row.release,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    const answered = group.filter(
      (r) => r.answered_at !== undefined && r.answered_at <= asOf && r.answer,
    );
    const assessed = answered.filter((r) => r.answer !== "not_checked");
    const solved = assessed.filter((r) => r.answer === "solved").length;
    const answeredIds = new Set(answered.map((r) => r._id));
    return {
      experiment_key: first.experiment_key,
      variant: first.experiment_variant,
      phase: first.feedback_phase,
      release: first.release,
      selected: group.length,
      users: new Set(group.map((r) => r.user_id)).size,
      duplicateUserInvitations:
        group.length - new Set(group.map((r) => r.user_id)).size,
      claimed: group.filter(
        (r) => r.shown_at !== undefined && r.shown_at <= asOf,
      ).length,
      viewed: group.filter(
        (r) => r.viewed_at !== undefined && r.viewed_at <= asOf,
      ).length,
      answered: answered.length,
      assessed: assessed.length,
      solved,
      helpful: answered.filter((r) => r.answer === "helpful").length,
      no: answered.filter((r) => r.answer === "no").length,
      notChecked: answered.filter((r) => r.answer === "not_checked").length,
      dismissed: group.filter(
        (r) => r.dismissed_at !== undefined && r.dismissed_at <= asOf,
      ).length,
      unanswered: group.length - answered.length,
      expiredUnanswered: group.filter(
        (r) => r.expires_at <= asOf && !answeredIds.has(r._id),
      ).length,
      reasons: Object.fromEntries(
        [
          "incorrect",
          "missed_request",
          "incomplete",
          "did_not_work",
          "refusal",
          "tool_problem",
          "other",
        ].map((reason) => [
          reason,
          answered.filter(
            (r) =>
              r.reason === reason &&
              r.reason_at !== undefined &&
              r.reason_at <= asOf,
          ).length,
        ]),
      ),
      responseRate: group.length ? answered.length / group.length : null,
      solvedPerSelected: group.length ? solved / group.length : null,
      solvedPerAssessed: assessed.length ? solved / assessed.length : null,
    };
  });
}
