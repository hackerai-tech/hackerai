import type { AgentActiveTimeCategory } from "@/types";

export type AgentStartupPhase =
  | "summary_generation"
  | "transcript_saving"
  | "sandbox_context"
  | "message_serialization";

export type AgentRunTimingSnapshot = {
  startupTimingVersion?: 1;
  routePreTriggerDurationMs?: number;
  triggerTaskStartLatencyMs?: number;
  taskToFirstModelStartMs?: number;
  requestToFirstModelStartMs?: number;
  requestToFirstModelChunkMs?: number;
  startupSubphaseTimingVersion?: 1;
  startupSummaryGenerationDurationMs?: number;
  startupTranscriptSavingDurationMs?: number;
  startupSandboxContextDurationMs?: number;
  startupMessageSerializationDurationMs?: number;
  approvalWaitCount: number;
  approvalWaitDurationMs: number;
  activeModelStreamDurationMs: number;
  activeTerminalWaitDurationMs: number;
  activeSandboxRecoveryDurationMs: number;
};

/**
 * Aggregates low-cardinality wall-clock phases for one Agent task run.
 * Trigger's usage duration remains the source of truth for billed runtime;
 * these categories explain where that active runtime was spent.
 */
export class AgentRunTimingTracker {
  private startup:
    | {
        requestStartedAt: number;
        triggerRequestedAt: number;
        taskStartedAt: number;
      }
    | undefined;
  private firstModelStartedAt: number | undefined;
  private firstModelChunkAt: number | undefined;
  private approvalWaitCount = 0;
  private approvalWaitDurationMs = 0;
  private activeModelStreamDurationMs = 0;
  private activeTerminalWaitDurationMs = 0;
  private activeSandboxRecoveryDurationMs = 0;
  private modelStreamStartedAt: number | undefined;
  private startupPhaseDurations = new Map<AgentStartupPhase, number>();

  constructor(private readonly now: () => number = Date.now) {}

  initializeStartup = (timing: {
    requestStartedAt: number;
    triggerRequestedAt: number;
    taskStartedAt: number;
  }): void => {
    if (
      !Number.isFinite(timing.requestStartedAt) ||
      !Number.isFinite(timing.triggerRequestedAt) ||
      !Number.isFinite(timing.taskStartedAt) ||
      timing.requestStartedAt > timing.triggerRequestedAt ||
      timing.triggerRequestedAt > timing.taskStartedAt
    ) {
      return;
    }
    this.startup = timing;
  };

  recordApprovalWait = (
    durationMs: number,
    incrementCount: boolean = true,
  ): void => {
    if (incrementCount) this.approvalWaitCount += 1;
    this.approvalWaitDurationMs += normalizeDuration(durationMs);
  };

  startModelStream = (): void => {
    this.finishModelStream();
    const startedAt = this.now();
    this.firstModelStartedAt ??= startedAt;
    this.modelStreamStartedAt = startedAt;
  };

  recordFirstModelChunk = (): void => {
    this.firstModelChunkAt ??= this.now();
  };

  finishModelStream = (): void => {
    if (this.modelStreamStartedAt === undefined) return;
    this.activeModelStreamDurationMs += normalizeDuration(
      this.now() - this.modelStreamStartedAt,
    );
    this.modelStreamStartedAt = undefined;
  };

  measureActiveTime = async <T>(
    category: AgentActiveTimeCategory,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = this.now();
    try {
      return await operation();
    } finally {
      const durationMs = normalizeDuration(this.now() - startedAt);
      if (category === "terminal_wait") {
        this.activeTerminalWaitDurationMs += durationMs;
      } else {
        this.activeSandboxRecoveryDurationMs += durationMs;
      }
    }
  };

  recordStartupPhaseDuration = (
    phase: AgentStartupPhase,
    durationMs: number,
  ): void => {
    if (
      this.firstModelStartedAt !== undefined &&
      phase !== "transcript_saving"
    ) {
      return;
    }
    const normalizedDuration = normalizeDuration(durationMs);
    this.startupPhaseDurations.set(
      phase,
      (this.startupPhaseDurations.get(phase) ?? 0) + normalizedDuration,
    );
  };

  measureStartupPhase = async <T>(
    phase: AgentStartupPhase,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = this.now();
    try {
      return await operation();
    } finally {
      this.recordStartupPhaseDuration(phase, this.now() - startedAt);
    }
  };

  snapshot = (): AgentRunTimingSnapshot => {
    const startup = this.startup;
    const summaryGenerationDurationMs =
      this.startupPhaseDurations.get("summary_generation");
    const transcriptSavingDurationMs =
      this.startupPhaseDurations.get("transcript_saving");
    const sandboxContextDurationMs =
      this.startupPhaseDurations.get("sandbox_context");
    const messageSerializationDurationMs = this.startupPhaseDurations.get(
      "message_serialization",
    );
    const hasStartupSubphaseTiming = this.startupPhaseDurations.size > 0;
    return {
      ...(startup && {
        startupTimingVersion: 1 as const,
        routePreTriggerDurationMs: normalizeDuration(
          startup.triggerRequestedAt - startup.requestStartedAt,
        ),
        triggerTaskStartLatencyMs: normalizeDuration(
          startup.taskStartedAt - startup.triggerRequestedAt,
        ),
        ...(this.firstModelStartedAt !== undefined && {
          taskToFirstModelStartMs: normalizeDuration(
            this.firstModelStartedAt - startup.taskStartedAt,
          ),
          requestToFirstModelStartMs: normalizeDuration(
            this.firstModelStartedAt - startup.requestStartedAt,
          ),
        }),
        ...(this.firstModelChunkAt !== undefined && {
          requestToFirstModelChunkMs: normalizeDuration(
            this.firstModelChunkAt - startup.requestStartedAt,
          ),
        }),
      }),
      ...(hasStartupSubphaseTiming && {
        startupSubphaseTimingVersion: 1 as const,
        ...(summaryGenerationDurationMs !== undefined && {
          startupSummaryGenerationDurationMs: summaryGenerationDurationMs,
        }),
        ...(transcriptSavingDurationMs !== undefined && {
          startupTranscriptSavingDurationMs: transcriptSavingDurationMs,
        }),
        ...(sandboxContextDurationMs !== undefined && {
          startupSandboxContextDurationMs: sandboxContextDurationMs,
        }),
        ...(messageSerializationDurationMs !== undefined && {
          startupMessageSerializationDurationMs: messageSerializationDurationMs,
        }),
      }),
      approvalWaitCount: this.approvalWaitCount,
      approvalWaitDurationMs: this.approvalWaitDurationMs,
      activeModelStreamDurationMs:
        this.activeModelStreamDurationMs +
        (this.modelStreamStartedAt === undefined
          ? 0
          : normalizeDuration(this.now() - this.modelStreamStartedAt)),
      activeTerminalWaitDurationMs: this.activeTerminalWaitDurationMs,
      activeSandboxRecoveryDurationMs: this.activeSandboxRecoveryDurationMs,
    };
  };
}

const normalizeDuration = (durationMs: number): number =>
  Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0;
