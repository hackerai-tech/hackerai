import type { AgentActiveTimeCategory } from "@/types";

export type AgentRunTimingSnapshot = {
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
  private approvalWaitCount = 0;
  private approvalWaitDurationMs = 0;
  private activeModelStreamDurationMs = 0;
  private activeTerminalWaitDurationMs = 0;
  private activeSandboxRecoveryDurationMs = 0;
  private modelStreamStartedAt: number | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  recordApprovalWait = (
    durationMs: number,
    incrementCount: boolean = true,
  ): void => {
    if (incrementCount) this.approvalWaitCount += 1;
    this.approvalWaitDurationMs += normalizeDuration(durationMs);
  };

  startModelStream = (): void => {
    this.finishModelStream();
    this.modelStreamStartedAt = this.now();
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

  snapshot = (): AgentRunTimingSnapshot => ({
    approvalWaitCount: this.approvalWaitCount,
    approvalWaitDurationMs: this.approvalWaitDurationMs,
    activeModelStreamDurationMs:
      this.activeModelStreamDurationMs +
      (this.modelStreamStartedAt === undefined
        ? 0
        : normalizeDuration(this.now() - this.modelStreamStartedAt)),
    activeTerminalWaitDurationMs: this.activeTerminalWaitDurationMs,
    activeSandboxRecoveryDurationMs: this.activeSandboxRecoveryDurationMs,
  });
}

const normalizeDuration = (durationMs: number): number =>
  Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0;
