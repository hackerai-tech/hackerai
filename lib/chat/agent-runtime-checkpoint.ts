export const AGENT_RUNTIME_CHECKPOINT_FLAG = "agent-runtime-checkpoint-v1";

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
