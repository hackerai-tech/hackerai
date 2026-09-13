export const SLOW_AGENT_FIRST_OUTPUT_THRESHOLD_MS = 15_000;
export const SLOW_AGENT_RUNTIME_THRESHOLD_MS = 120_000;

export type AgentInitialDelayPhase =
  | "route_pre_trigger"
  | "trigger_start"
  | "pre_model"
  | "provider_first_chunk"
  | "none";

export type AgentRuntimePhase =
  | "model_stream"
  | "terminal_wait"
  | "approval_wait"
  | "sandbox_recovery"
  | "unattributed"
  | "none";

export type AgentPerformanceTiming = {
  triggerUsageDurationMs?: number;
  routePreTriggerDurationMs?: number;
  triggerTaskStartLatencyMs?: number;
  taskToFirstModelStartMs?: number;
  requestToFirstModelStartMs?: number;
  requestToFirstModelChunkMs?: number;
  approvalWaitDurationMs?: number;
  activeModelStreamDurationMs?: number;
  activeTerminalWaitDurationMs?: number;
  activeSandboxRecoveryDurationMs?: number;
};

export type AgentPerformanceDiagnostics = {
  version: 1;
  initialDelayPhase: AgentInitialDelayPhase;
  initialDelayPhaseDurationMs: number;
  providerFirstChunkDurationMs?: number;
  primaryRuntimePhase: AgentRuntimePhase;
  primaryRuntimePhaseDurationMs: number;
  accountedRuntimeDurationMs: number;
  unattributedRuntimeDurationMs?: number;
  firstOutputSlow?: boolean;
  runtimeSlow?: boolean;
};

type DurationCandidate<T extends string> = {
  phase: T;
  durationMs: number;
};

const normalizeDuration = (
  durationMs: number | undefined,
): number | undefined =>
  durationMs === undefined || !Number.isFinite(durationMs)
    ? undefined
    : Math.max(0, Math.round(durationMs));

const longestPhase = <T extends string>(
  candidates: Array<DurationCandidate<T>>,
  none: T,
): DurationCandidate<T> =>
  candidates.reduce<DurationCandidate<T>>(
    (longest, candidate) =>
      candidate.durationMs > longest.durationMs ? candidate : longest,
    { phase: none, durationMs: 0 },
  );

/**
 * Turns the raw Agent timing counters into bounded, queryable classifications.
 * The inputs are durations only; no prompt, filename, URL, or tool output is
 * inspected or emitted.
 */
export function buildAgentPerformanceDiagnostics(
  timing: AgentPerformanceTiming,
): AgentPerformanceDiagnostics | undefined {
  const normalized = {
    triggerUsageDurationMs: normalizeDuration(timing.triggerUsageDurationMs),
    routePreTriggerDurationMs: normalizeDuration(
      timing.routePreTriggerDurationMs,
    ),
    triggerTaskStartLatencyMs: normalizeDuration(
      timing.triggerTaskStartLatencyMs,
    ),
    taskToFirstModelStartMs: normalizeDuration(timing.taskToFirstModelStartMs),
    requestToFirstModelStartMs: normalizeDuration(
      timing.requestToFirstModelStartMs,
    ),
    requestToFirstModelChunkMs: normalizeDuration(
      timing.requestToFirstModelChunkMs,
    ),
    approvalWaitDurationMs: normalizeDuration(timing.approvalWaitDurationMs),
    activeModelStreamDurationMs: normalizeDuration(
      timing.activeModelStreamDurationMs,
    ),
    activeTerminalWaitDurationMs: normalizeDuration(
      timing.activeTerminalWaitDurationMs,
    ),
    activeSandboxRecoveryDurationMs: normalizeDuration(
      timing.activeSandboxRecoveryDurationMs,
    ),
  };

  if (Object.values(normalized).every((duration) => duration === undefined)) {
    return undefined;
  }

  const providerFirstChunkDurationMs =
    normalized.requestToFirstModelChunkMs !== undefined &&
    normalized.requestToFirstModelStartMs !== undefined
      ? Math.max(
          0,
          normalized.requestToFirstModelChunkMs -
            normalized.requestToFirstModelStartMs,
        )
      : undefined;

  const initialDelay = longestPhase<AgentInitialDelayPhase>(
    [
      {
        phase: "route_pre_trigger",
        durationMs: normalized.routePreTriggerDurationMs ?? 0,
      },
      {
        phase: "trigger_start",
        durationMs: normalized.triggerTaskStartLatencyMs ?? 0,
      },
      {
        phase: "pre_model",
        durationMs: normalized.taskToFirstModelStartMs ?? 0,
      },
      {
        phase: "provider_first_chunk",
        durationMs: providerFirstChunkDurationMs ?? 0,
      },
    ],
    "none",
  );

  // Trigger usage starts with task execution, so route and Trigger queue time
  // are intentionally excluded from this accounting. Provider first-chunk
  // latency is already contained in active model-stream time.
  const accountedRuntimeDurationMs =
    (normalized.taskToFirstModelStartMs ?? 0) +
    (normalized.approvalWaitDurationMs ?? 0) +
    (normalized.activeModelStreamDurationMs ?? 0) +
    (normalized.activeTerminalWaitDurationMs ?? 0) +
    (normalized.activeSandboxRecoveryDurationMs ?? 0);
  const unattributedRuntimeDurationMs =
    normalized.triggerUsageDurationMs === undefined
      ? undefined
      : Math.max(
          0,
          normalized.triggerUsageDurationMs - accountedRuntimeDurationMs,
        );
  const runtimePhase = longestPhase<AgentRuntimePhase>(
    [
      {
        phase: "model_stream",
        durationMs: normalized.activeModelStreamDurationMs ?? 0,
      },
      {
        phase: "terminal_wait",
        durationMs: normalized.activeTerminalWaitDurationMs ?? 0,
      },
      {
        phase: "approval_wait",
        durationMs: normalized.approvalWaitDurationMs ?? 0,
      },
      {
        phase: "sandbox_recovery",
        durationMs: normalized.activeSandboxRecoveryDurationMs ?? 0,
      },
      {
        phase: "unattributed",
        durationMs: unattributedRuntimeDurationMs ?? 0,
      },
    ],
    "none",
  );

  return {
    version: 1,
    initialDelayPhase: initialDelay.phase,
    initialDelayPhaseDurationMs: initialDelay.durationMs,
    ...(providerFirstChunkDurationMs !== undefined && {
      providerFirstChunkDurationMs,
    }),
    primaryRuntimePhase: runtimePhase.phase,
    primaryRuntimePhaseDurationMs: runtimePhase.durationMs,
    accountedRuntimeDurationMs,
    ...(unattributedRuntimeDurationMs !== undefined && {
      unattributedRuntimeDurationMs,
    }),
    ...(normalized.requestToFirstModelChunkMs !== undefined && {
      firstOutputSlow:
        normalized.requestToFirstModelChunkMs >=
        SLOW_AGENT_FIRST_OUTPUT_THRESHOLD_MS,
    }),
    ...(normalized.triggerUsageDurationMs !== undefined && {
      runtimeSlow:
        normalized.triggerUsageDurationMs >= SLOW_AGENT_RUNTIME_THRESHOLD_MS,
    }),
  };
}
