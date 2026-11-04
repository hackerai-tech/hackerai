import type { GoalState } from "./contracts";

export type GoalTiming = {
  state: GoalState;
  startedAt?: number;
  achievedAt?: number;
  updatedAt: number;
  elapsedMs?: number;
  activeSince?: number;
};

export function isGoalTimerRunning(state: GoalState): boolean {
  return state === "queued" || state === "running";
}

export function goalElapsedMs(goal: GoalTiming, now: number): number {
  if (goal.elapsedMs !== undefined) {
    return (
      goal.elapsedMs +
      (isGoalTimerRunning(goal.state) && goal.activeSince !== undefined
        ? Math.max(0, now - goal.activeSince)
        : 0)
    );
  }
  // Older goals have no pause history. Freeze their existing duration at the
  // last state update, then persist it on the next transition.
  const end =
    goal.achievedAt ?? (isGoalTimerRunning(goal.state) ? now : goal.updatedAt);
  return Math.max(0, end - (goal.startedAt ?? end));
}

/** Settle the previous interval exactly once whenever the goal changes state. */
export function goalTimingForState(
  goal: GoalTiming,
  state: GoalState,
  now: number,
): { elapsedMs: number; activeSince: number | undefined } {
  return {
    elapsedMs: goalElapsedMs(goal, now),
    activeSince: isGoalTimerRunning(state) ? now : undefined,
  };
}
