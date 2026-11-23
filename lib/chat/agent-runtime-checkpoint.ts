export const AGENT_RUNTIME_CHECKPOINT_FLAG = "agent-runtime-checkpoint-v1";
export const AGENT_LIMIT_WRAPUP_FLAG = "agent-limit-wrapup-v1";

/** Fraction of a hard step or usage limit at which the wrap-up fires. At the
 * Agent step limit this leaves dozens of steps for delivery and the report. */
const LIMIT_WRAPUP_FRACTION = 0.9;

/** Optional assignment must not hold startup through analytics SDK retries. */
export function resolveAgentRuntimeCheckpointEnabled({
  loadDecision,
  signal,
}: {
  loadDecision: () => Promise<boolean | null>;
  signal: AbortSignal;
}): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (enabled: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(enabled);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), 1000);
    signal.addEventListener("abort", onAbort, { once: true });
    // Attach both handlers even if the timeout/abort wins. Late SDK results
    // cannot change assignment or cause an unhandled rejection.
    Promise.resolve()
      .then(loadDecision)
      .then(
        (decision) => finish(decision === true),
        () => finish(false),
      );
  });
}

/** Run progress observed before each model request. */
export type AgentRunLimitProgress = {
  /** Model steps completed in this run, across stream retries. */
  completedSteps: number;
  maxSteps: number;
  /** Projected usage percent, present only when reaching 100% stops the run. */
  budgetUsedPercent?: number;
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
  if (percent === undefined) return "none";
  if (percent < 90) return "<90";
  if (percent < 95) return "90-94";
  if (percent < 100) return "95-99";
  return "100+";
}

function prepareLimitWrapUp({
  completedSteps,
  maxSteps,
  budgetUsedPercent,
}: AgentRunLimitProgress):
  { notice: string; exposure: AgentLimitWrapUpExposure } | undefined {
  const usage =
    Number.isFinite(budgetUsedPercent) &&
    budgetUsedPercent! >= LIMIT_WRAPUP_FRACTION * 100;
  const step =
    Number.isFinite(completedSteps) &&
    Number.isFinite(maxSteps) &&
    maxSteps > 0 &&
    completedSteps >= Math.floor(maxSteps * LIMIT_WRAPUP_FRACTION);
  if (!usage && !step) return undefined;
  const kind = usage ? "usage" : "step";
  return {
    exposure: {
      trigger_kind: kind,
      step_count_bucket: bucketStepCount(completedSteps),
      budget_pct_bucket: bucketBudgetPercent(budgetUsedPercent),
    },
    notice: `\n\n<agent_limit_wrapup>
This run is close to its ${kind} limit and may stop after a few more steps. Do not start new long-running scans, installs, or other extended work. Use get_terminal_files to deliver produced files the user needs, then write a short final report that separates done, blocked, and unverified items and lists next steps. Claim only what the tool results support.
</agent_limit_wrapup>`,
  };
}

export type AgentRuntimeCheckpoint = {
  /** Prepare without consuming; a failed preparation may retry before dispatch.
   * At most one notice, runtime or limit wrap-up, is exposed per run. */
  takeNotice: (progress?: AgentRunLimitProgress) => string | undefined;
  /** Commit only when the prepared model step starts. */
  recordExposure: () => void;
};

/** Own this once per run, outside stream retries. The caller supplies the same
 * pause-aware clock and allowance used by its existing runtime stop condition.
 * The optional limit wrap-up shares this one-notice budget and wins when both
 * are due, since its hard stop does not continue automatically. */
export function createAgentRuntimeCheckpoint({
  enabled,
  maxDurationMs,
  getElapsedTimeMs,
  onExposed,
  limitWrapUp,
}: {
  enabled: boolean;
  maxDurationMs?: number;
  getElapsedTimeMs: () => number;
  onExposed: (timing: { elapsed_ms: number; allowance_ms: number }) => void;
  limitWrapUp?: {
    enabled: boolean;
    onExposed: (exposure: AgentLimitWrapUpExposure) => void;
  };
}): AgentRuntimeCheckpoint {
  let taken = false;
  let pendingExposure: (() => void) | undefined;
  const takeRuntimeNotice = () => {
    if (
      !enabled ||
      maxDurationMs === undefined ||
      !Number.isFinite(maxDurationMs) ||
      maxDurationMs <= 0
    )
      return undefined;
    const elapsed = getElapsedTimeMs();
    if (
      !Number.isFinite(elapsed) ||
      elapsed < maxDurationMs * 0.9 ||
      elapsed >= maxDurationMs
    )
      return undefined;
    const timing = { elapsed_ms: elapsed, allowance_ms: maxDurationMs };
    pendingExposure = () => onExposed(timing);
    return `\n\n<agent_runtime_checkpoint>
About 90% of this run's active time allowance has elapsed. Review your strongest current hypothesis and the proof gaps that remain. Prioritize a discriminating verification that could confirm or reject it, using the evidence and work already available. Continue useful work within the remaining allowance; this checkpoint does not ask you to finish early. Report uncertainty honestly and claim success only when the required verification supports it.
</agent_runtime_checkpoint>`;
  };
  return {
    takeNotice(progress) {
      pendingExposure = undefined;
      if (taken) return undefined;
      const wrapUp =
        limitWrapUp?.enabled && progress
          ? prepareLimitWrapUp(progress)
          : undefined;
      if (wrapUp) {
        pendingExposure = () => limitWrapUp!.onExposed(wrapUp.exposure);
        return wrapUp.notice;
      }
      return takeRuntimeNotice();
    },
    recordExposure() {
      if (!pendingExposure) return;
      const expose = pendingExposure;
      pendingExposure = undefined;
      taken = true;
      // Optional telemetry must not affect model execution.
      try {
        expose();
      } catch {
        /* best effort */
      }
    },
  };
}
