import type { BudgetStopHeadroom } from "@/lib/chat/budget-monitor";

/** Private note id; the runner keeps the note at its first position. */
export const AGENT_LIMIT_WRAPUP_NOTE_ID = "agent-limit-wrapup";

/** Steps of usage left when the usage wrap-up fires: one to deliver files, one
 * for the report, and one for a step that costs more than recent ones. */
const USAGE_WRAPUP_RESERVE_STEPS = 3;

/** Steps left when the step wrap-up fires: 10 of the 500 Agent steps, enough
 * to settle an in-flight step, deliver files and report. Smaller limits keep
 * 10%, and at least one step. */
function stepWrapUpReserve(maxSteps: number): number {
  return Math.max(1, Math.min(10, Math.ceil(maxSteps / 10)));
}

/** Run progress observed before each model request. */
export type AgentRunLimitProgress = {
  /** Model steps completed in this run, across stream retries. */
  completedSteps: number;
  maxSteps: number;
  /** Present only when a usage stop applies to this run. */
  budget?: BudgetStopHeadroom;
};

export type AgentLimitWrapUpExposure = {
  trigger_kind: "step" | "usage";
  step_count_bucket: string;
  budget_pct_bucket: string;
};

const STEP_BUCKETS = [10, 50, 100, 250, 450] as const;

function bucketStepCount(steps: number): string {
  let lower = 0;
  for (const upper of STEP_BUCKETS) {
    if (steps < upper) return `${lower}-${upper - 1}`;
    lower = upper;
  }
  return `${lower}+`;
}

function bucketBudgetPercent(percent: number | undefined): string {
  if (percent === undefined || !Number.isFinite(percent)) return "none";
  if (percent < 90) return "<90";
  if (percent < 95) return "90-94";
  if (percent < 100) return "95-99";
  return "100+";
}

function prepareLimitWrapUp({
  completedSteps,
  maxSteps,
  budget,
}: AgentRunLimitProgress):
  { notice: string; exposure: AgentLimitWrapUpExposure } | undefined {
  const stepsLeft =
    Number.isFinite(completedSteps) && Number.isFinite(maxSteps) && maxSteps > 0
      ? maxSteps - completedSteps
      : undefined;
  const usageStepsLeft =
    budget &&
    Number.isFinite(budget.remainingPoints) &&
    budget.recentStepCostPoints > 0
      ? budget.remainingPoints / budget.recentStepCostPoints
      : undefined;
  const stepDue =
    stepsLeft !== undefined && stepsLeft <= stepWrapUpReserve(maxSteps);
  const usageDue =
    usageStepsLeft !== undefined &&
    usageStepsLeft <= USAGE_WRAPUP_RESERVE_STEPS;
  if (!stepDue && !usageDue) return undefined;
  // Name the limit that stops the run first.
  const kind =
    usageDue && (!stepDue || usageStepsLeft! <= stepsLeft!) ? "usage" : "step";
  const left = Math.max(
    1,
    Math.floor(kind === "usage" ? usageStepsLeft! : stepsLeft!),
  );
  return {
    exposure: {
      trigger_kind: kind,
      step_count_bucket: bucketStepCount(completedSteps),
      budget_pct_bucket: bucketBudgetPercent(budget?.usedPercent),
    },
    notice: `<system-reminder>
<agent_limit_wrapup>
This run is close to its ${kind} limit and will stop in about ${left} more model ${left === 1 ? "step" : "steps"}. Do not start new long-running scans, installs, or other extended work. Use get_terminal_files to deliver produced files the user needs, then write a short final report that separates done, blocked, and unverified items and lists next steps. Claim only what the tool results support.
</agent_limit_wrapup>
</system-reminder>`,
  };
}

export type AgentLimitWrapUp = {
  /** The note for this model request. Before exposure it is prepared only
   * near a limit, and a failed preparation is re-evaluated. Once exposed, the
   * same note returns for every later request. */
  prepare: (progress: AgentRunLimitProgress) => string | undefined;
  /** Commit the prepared note when its model step starts. */
  recordExposure: () => void;
};

/** Own this once per run, outside stream retries. The wrap-up never changes a
 * limit: the step and usage stops apply exactly as before. */
export function createAgentLimitWrapUp({
  onExposed,
}: {
  onExposed: (exposure: AgentLimitWrapUpExposure) => void;
}): AgentLimitWrapUp {
  let exposedNotice: string | undefined;
  let pending: ReturnType<typeof prepareLimitWrapUp>;
  return {
    prepare(progress) {
      if (exposedNotice !== undefined) return exposedNotice;
      pending = prepareLimitWrapUp(progress);
      return pending?.notice;
    },
    recordExposure() {
      if (!pending) return;
      const { notice, exposure } = pending;
      pending = undefined;
      exposedNotice = notice;
      // Optional telemetry must not affect model execution.
      try {
        onExposed(exposure);
      } catch {
        /* best effort */
      }
    },
  };
}
