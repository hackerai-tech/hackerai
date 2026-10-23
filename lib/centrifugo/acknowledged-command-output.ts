/** A bounded, connection-independent delivery window. Publishing is not receipt. */
export interface CommandOutputChunk {
  type: "stdout" | "stderr" | "exit" | "error";
  data?: string;
  exitCode?: number;
  message?: string;
}

export interface AcknowledgedCommandFrame extends CommandOutputChunk {
  commandId: string;
  sequence: number;
  outputProtocol: "ack-v1";
}

/** Sender-side receipt evidence only; never command contents or execution success. */
export interface AcknowledgedCommandSettlement {
  outcome: "acknowledged" | "canceled" | "incomplete";
  reason:
    | "terminal_ack"
    | "canceled"
    | "buffer_limit"
    | "deadline_exceeded"
    | "ownership_lost"
    | "stopped";
  observedFrames: number;
  enqueuedFrames: number;
  acknowledgedFrames: number;
  publishAttempts: number;
  replayAttempts: number;
  publishFailures: number;
  resumeRequests: number;
  pendingFrames: number;
  pendingBytes: number;
  peakPendingBytes: number;
  terminalType: "exit" | "error" | null;
  terminalAcknowledged: boolean;
  durationMs: number;
}

export class AcknowledgedCommandOutput {
  private pending = new Map<
    number,
    {
      frame: AcknowledgedCommandFrame;
      bytes: number;
      sentAt: number;
      attempts: number;
    }
  >();
  private readonly startedAt = Date.now();
  private observedFrames = 0;
  private publishAttempts = 0;
  private replayAttempts = 0;
  private publishFailures = 0;
  private resumeRequests = 0;
  private peakPendingBytes = 0;
  private terminalType: "exit" | "error" | null = null;
  private bytes = 0;
  private nextSequence = 0;
  private highestSent = -1;
  private acknowledged = -1;
  private terminalSequence: number | undefined;
  private pumping = false;
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  private resolve!: () => void;
  private reject!: (error: Error) => void;
  readonly delivered: Promise<void>;
  canceled = false;

  constructor(
    private commandId: string,
    private deadline: number,
    private publish: (frame: AcknowledgedCommandFrame) => Promise<unknown>,
    private isActive: () => boolean,
    private onSettled?: (
      settlement: Readonly<AcknowledgedCommandSettlement>,
    ) => void,
  ) {
    this.delivered = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // Native callbacks may fill/expire the window before invocation returns.
    void this.delivered.catch(() => {});
    this.timer = setInterval(() => {
      void this.pump();
    }, 250);
  }

  append(chunk: CommandOutputChunk): void {
    if (this.closed || this.terminalSequence !== undefined) return;
    this.observedFrames++;
    if (chunk.type === "exit" || chunk.type === "error")
      this.terminalType = chunk.type;
    const bytes = new TextEncoder().encode(
      chunk.data ?? chunk.message ?? "",
    ).byteLength;
    if (this.pending.size >= 4096 || this.bytes + bytes > 8 * 1024 * 1024) {
      this.stop(
        new Error(
          "Command output recovery buffer exceeded; output completeness is unknown.",
        ),
        "buffer_limit",
      );
      return;
    }
    const sequence = this.nextSequence++;
    if (chunk.type === "exit" || chunk.type === "error")
      this.terminalSequence = sequence;
    this.pending.set(sequence, {
      frame: {
        ...chunk,
        commandId: this.commandId,
        sequence,
        outputProtocol: "ack-v1",
      },
      bytes,
      sentAt: -Infinity,
      attempts: 0,
    });
    this.bytes += bytes;
    this.peakPendingBytes = Math.max(this.peakPendingBytes, this.bytes);
    void this.pump();
  }

  /** Cumulative receipt; never allow a future/unpublished cursor to discard data. */
  acknowledge(sequence: number): void {
    if (
      this.closed ||
      !Number.isSafeInteger(sequence) ||
      sequence < -1 ||
      sequence > this.highestSent ||
      sequence < this.acknowledged
    )
      return;
    this.acknowledged = sequence;
    for (const [id, entry] of this.pending) {
      if (id > sequence) break;
      this.bytes -= entry.bytes;
      this.pending.delete(id);
    }
    if (
      this.terminalSequence !== undefined &&
      sequence === this.terminalSequence
    ) {
      this.close("terminal_ack");
      this.resolve();
    } else {
      void this.pump();
    }
  }

  /** Resume only an existing stream. This operation never invokes execution. */
  resume(sequence: number): void {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < -1 ||
      sequence > this.highestSent ||
      this.closed
    )
      return;
    // An older resume may overtake an ACK in transit. It must not fail the
    // live stream or move its cursor backwards. Process restarts require the
    // persisted execution record, not a fresh execution request.
    if (sequence < this.acknowledged) return;
    this.resumeRequests++;
    this.acknowledge(sequence);
    for (const entry of this.pending.values()) entry.sentAt = -Infinity;
    void this.pump();
  }

  cancel(): void {
    this.canceled = true;
    this.stop(new Error("Command output delivery canceled."), "canceled");
  }

  stop(
    error = new Error(
      "Command output delivery stopped; completion is unknown.",
    ),
    reason: Exclude<
      AcknowledgedCommandSettlement["reason"],
      "terminal_ack"
    > = "stopped",
  ): void {
    if (this.closed) return;
    this.close(reason);
    this.reject(error);
  }

  private close(reason: AcknowledgedCommandSettlement["reason"]): void {
    const settlement: Readonly<AcknowledgedCommandSettlement> = Object.freeze({
      outcome:
        reason === "terminal_ack"
          ? "acknowledged"
          : reason === "canceled"
            ? "canceled"
            : "incomplete",
      reason,
      observedFrames: this.observedFrames,
      enqueuedFrames: this.nextSequence,
      acknowledgedFrames: this.acknowledged + 1,
      publishAttempts: this.publishAttempts,
      replayAttempts: this.replayAttempts,
      publishFailures: this.publishFailures,
      resumeRequests: this.resumeRequests,
      pendingFrames: this.pending.size,
      pendingBytes: this.bytes,
      peakPendingBytes: this.peakPendingBytes,
      terminalType: this.terminalType,
      terminalAcknowledged: reason === "terminal_ack",
      durationMs: Math.max(0, Date.now() - this.startedAt),
    });
    this.closed = true;
    clearInterval(this.timer);
    this.pending.clear();
    this.bytes = 0;
    // Telemetry must neither retain output nor affect delivery or rejection.
    try {
      this.onSettled?.(settlement);
    } catch {
      /* Best effort observer. */
    }
  }

  private async pump(): Promise<void> {
    if (this.closed) return;
    const active = this.isActive();
    if (!active || Date.now() >= this.deadline) {
      this.stop(
        new Error(
          "Command output acknowledgement deadline exceeded; completion is unknown.",
        ),
        active ? "deadline_exceeded" : "ownership_lost",
      );
      return;
    }
    if (this.pumping) return;
    this.pumping = true;
    try {
      // A sliding window bounds unacknowledged traffic. Lost ACKs and messages
      // both cause idempotent output replay; neither causes command replay.
      let count = 0;
      for (const [sequence, entry] of this.pending) {
        if (
          this.closed ||
          !this.isActive() ||
          Date.now() >= this.deadline ||
          count++ >= 32
        )
          break;
        if (Date.now() - entry.sentAt < 1000) continue;
        entry.sentAt = Date.now();
        this.highestSent = Math.max(this.highestSent, sequence);
        this.publishAttempts++;
        if (entry.attempts++ > 0) this.replayAttempts++;
        try {
          await this.publish(entry.frame);
        } catch {
          if (!this.closed) this.publishFailures++;
          break;
        } // Retain on uncertain transport outcomes until receipt/deadline.
      }
    } finally {
      this.pumping = false;
    }
  }
}
