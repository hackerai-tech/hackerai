// Native vision recovery stops on agent-reported verification feedback, not on
// elapsed time or accepted stages. Each Next/Verify result observed before
// more input is one sequential report.
export type VisionProgressOutcome = "advanced" | "rejected" | "uncertain";
export type VisionProgressReport = {
  attempt: number;
  outcome: VisionProgressOutcome;
};
export type VisionProgressStop =
  "vision_verification_rejected" | "vision_feedback_uncertain";
export type VisionProgress = {
  /** Never reset by a later accepted stage. */
  readonly rejected: number;
  readonly nextAttempt: number;
  readonly last?: VisionProgressReport;
  readonly stopped?: VisionProgressStop;
};

export const VISION_REJECTION_LIMIT = 2;
export const INITIAL_VISION_PROGRESS: VisionProgress = {
  rejected: 0,
  nextAttempt: 1,
};

const OUTCOMES: readonly string[] = ["advanced", "rejected", "uncertain"];

/** Returns undefined for a malformed report, which counts as uncertain. */
export function parseVisionProgressReport(
  attempt: string,
  outcome: string,
): VisionProgressReport | undefined {
  if (!/^[1-9][0-9]{0,5}$/.test(attempt) || !OUTCOMES.includes(outcome))
    return undefined;
  return {
    attempt: Number(attempt),
    outcome: outcome as VisionProgressOutcome,
  };
}

/** Returns the same state object when the report must not mutate it. */
export function applyVisionProgress(
  state: VisionProgress,
  report: VisionProgressReport | undefined,
): VisionProgress {
  const { last } = state;
  // Stops are sticky. A repeated or older report cannot count twice or reset
  // the sequence.
  if (
    state.stopped ||
    (report &&
      last &&
      (report.attempt < last.attempt ||
        (report.attempt === last.attempt && report.outcome === last.outcome)))
  )
    return state;
  // Conflicting, skipped, malformed or uncertain feedback: stop, never guess.
  if (
    !report ||
    report.attempt !== state.nextAttempt ||
    report.outcome === "uncertain"
  )
    return { ...state, stopped: "vision_feedback_uncertain" };
  const rejected = state.rejected + (report.outcome === "rejected" ? 1 : 0);
  return {
    rejected,
    nextAttempt: report.attempt + 1,
    last: report,
    ...(rejected >= VISION_REJECTION_LIMIT && {
      stopped: "vision_verification_rejected" as const,
    }),
  };
}
