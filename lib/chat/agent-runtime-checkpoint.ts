export const AGENT_RUNTIME_CHECKPOINT_FLAG = "agent-runtime-checkpoint-v1";

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

export type AgentRuntimeCheckpoint = {
  /** Prepare without consuming; a failed preparation may retry before dispatch. */
  takeNotice: () => string | undefined;
  /** Commit only when the prepared model step starts. */
  recordExposure: () => void;
};

/** Own this once per run, outside stream retries. The caller supplies the same
 * pause-aware clock and allowance used by its existing runtime stop condition. */
export function createAgentRuntimeCheckpoint({
  enabled,
  maxDurationMs,
  getElapsedTimeMs,
  onExposed,
}: {
  enabled: boolean;
  maxDurationMs?: number;
  getElapsedTimeMs: () => number;
  onExposed: (timing: { elapsed_ms: number; allowance_ms: number }) => void;
}): AgentRuntimeCheckpoint {
  let taken = false;
  let pendingExposure: { elapsed_ms: number; allowance_ms: number } | undefined;
  return {
    takeNotice() {
      if (
        !enabled ||
        taken ||
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
      pendingExposure = { elapsed_ms: elapsed, allowance_ms: maxDurationMs };
      return `\n\n<agent_runtime_checkpoint>
About 90% of this run's active time allowance has elapsed. Review your strongest current hypothesis and the proof gaps that remain. Prioritize a discriminating verification that could confirm or reject it, using the evidence and work already available. Continue useful work within the remaining allowance; this checkpoint does not ask you to finish early. Report uncertainty honestly and claim success only when the required verification supports it.
</agent_runtime_checkpoint>`;
    },
    recordExposure() {
      if (!pendingExposure) return;
      const timing = pendingExposure;
      pendingExposure = undefined;
      taken = true;
      // Optional telemetry must not affect model execution.
      try {
        onExposed(timing);
      } catch {
        /* best effort */
      }
    },
  };
}
