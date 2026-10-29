import { v4 as uuidv4 } from "uuid";
import { sampleDiagnosticOperation } from "./diagnostic-sampling";
import {
  captureQueuedAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
  subscribeAuthenticatedAnalytics,
} from "./client";
import type { AcknowledgedCommandSettlement } from "../centrifugo/acknowledged-command-output";
import {
  isDesktopAckAge,
  isDesktopAckStopSource,
  type DesktopAckStopSource,
} from "./desktop-ack-privacy";

interface DesktopAckContext {
  connectionId: string | null;
  commandId: string;
  chatId?: string;
  triggerRunId?: string;
}

type DesktopAckSettlement = Readonly<AcknowledgedCommandSettlement> & {
  terminalExitCode?: number | null;
};

const emptyCounts = () => ({
  startedCount: 0,
  settledCount: 0,
  acknowledgedCount: 0,
  canceledCount: 0,
  incompleteCount: 0,
  terminalErrorCount: 0,
  nonzeroExitCount: 0,
  retryEvidenceCount: 0,
  retryEvidenceAcknowledgedCount: 0,
  bufferLimitCount: 0,
  deadlineExceededCount: 0,
  ownershipLostCount: 0,
  stoppedCount: 0,
  publishFailureCount: 0,
  replayCount: 0,
  resumeCount: 0,
});

/** Unsampled delivery counters, sampled pairs, and all exceptional finals.
 * Owned by one bridge; never retain command contents or an unbounded ID map.
 */
export class DesktopAckTelemetry {
  private owner: string | null = null;
  private generation = 0;
  private sessionId = "";
  private sequence = 0;
  private properties: Record<string, unknown> = {};
  private counts = emptyCounts();
  private pending = 0;
  private pendingAtStart = 0;
  private windowStartedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private onPageHide = () => this.flush();
  private onVisibility = () => {
    if (document.visibilityState === "hidden") this.flush();
  };

  private scheduleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 60_000);
  }

  private capture(
    event: string,
    properties: Record<string, unknown>,
    dedupeKey: string,
  ) {
    if (!this.owner || getIdentifiedAnalyticsUserId() !== this.owner)
      return false;
    try {
      return captureQueuedAuthenticatedEvent({ event, properties, dedupeKey });
    } catch {
      return false;
    }
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.owner || getIdentifiedAnalyticsUserId() !== this.owner) {
      this.reset();
      return;
    }
    if (this.counts.startedCount === 0 && this.counts.settledCount === 0)
      return;
    if (
      this.capture(
        "desktop_ack_delivery_summary",
        {
          ...this.properties,
          ...this.counts,
          telemetrySessionId: this.sessionId,
          windowSequence: this.sequence,
          telemetry_sample_rate: 1,
          pendingAtStart: this.pendingAtStart,
          pendingAtEnd: this.pending,
          windowStartedAt: new Date(this.windowStartedAt).toISOString(),
          windowEndedAt: new Date().toISOString(),
        },
        `${this.sessionId}:${this.sequence}`,
      )
    ) {
      this.sequence++;
      this.counts = emptyCounts();
      this.pendingAtStart = this.pending;
      this.windowStartedAt = Date.now();
    } else {
      this.scheduleFlush();
    }
  }

  private reset() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (typeof window !== "undefined")
      window.removeEventListener("pagehide", this.onPageHide);
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", this.onVisibility);
    this.owner = null;
    this.counts = emptyCounts();
    this.pending = this.pendingAtStart = 0;
    this.generation++;
  }

  dispose() {
    this.flush();
    this.reset();
  }

  start(context: DesktopAckContext) {
    const userId = getIdentifiedAnalyticsUserId();
    if (!userId) return () => {};
    if (
      this.owner !== userId ||
      this.properties.connectionId !== context.connectionId
    ) {
      this.dispose();
      this.owner = userId;
      this.sessionId = uuidv4();
      this.sequence = 0;
      this.windowStartedAt = Date.now();
      const commit = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
      this.properties = {
        schemaVersion: 2,
        outputProtocol: "ack-v1",
        connectionId: context.connectionId,
        ...(/^[a-f0-9]{40}$/i.test(commit ?? "") && {
          hackerai_frontend_build_commit: commit,
        }),
      };
      this.unsubscribe = subscribeAuthenticatedAnalytics(() => {
        if (getIdentifiedAnalyticsUserId() !== this.owner) this.reset();
      });
      if (typeof window !== "undefined")
        window.addEventListener("pagehide", this.onPageHide);
      if (typeof document !== "undefined")
        document.addEventListener("visibilitychange", this.onVisibility);
    }
    const generation = this.generation;
    const dedupeKey = JSON.stringify([context.connectionId, context.commandId]);
    const sampled = sampleDiagnosticOperation(dedupeKey);
    const properties = {
      ...this.properties,
      commandId: context.commandId,
      ...(context.chatId && { chatId: context.chatId }),
      ...(context.triggerRunId && { triggerRunId: context.triggerRunId }),
      telemetry_sampled: sampled,
    };
    this.counts.startedCount++;
    this.pending++;
    this.scheduleFlush();
    if (sampled)
      this.capture(
        "desktop_ack_command_started",
        {
          ...properties,
          telemetry_sample_rate: 0.1,
        },
        dedupeKey,
      );
    let settled = false;
    return (
      result: DesktopAckSettlement,
      stopSource?: DesktopAckStopSource,
    ) => {
      if (settled) return;
      settled = true;
      if (
        generation !== this.generation ||
        getIdentifiedAnalyticsUserId() !== userId
      )
        return;
      const recovery =
        result.publishFailures > 0 ||
        result.replayAttempts > 0 ||
        result.resumeRequests > 0;
      const diagnostic =
        recovery ||
        result.outcome !== "acknowledged" ||
        result.reason !== "terminal_ack" ||
        !result.terminalAcknowledged ||
        result.terminalType !== "exit" ||
        result.terminalExitCode !== 0 ||
        result.durationMs >= 30_000;
      this.pending--;
      this.counts.settledCount++;
      if (result.outcome === "acknowledged") this.counts.acknowledgedCount++;
      if (result.outcome === "canceled") this.counts.canceledCount++;
      if (result.outcome === "incomplete") this.counts.incompleteCount++;
      if (result.terminalType === "error") this.counts.terminalErrorCount++;
      if (
        typeof result.terminalExitCode === "number" &&
        result.terminalExitCode !== 0
      )
        this.counts.nonzeroExitCount++;
      if (recovery) {
        this.counts.retryEvidenceCount++;
        if (result.outcome === "acknowledged")
          this.counts.retryEvidenceAcknowledgedCount++;
      }
      if (result.reason === "buffer_limit") this.counts.bufferLimitCount++;
      if (result.reason === "deadline_exceeded")
        this.counts.deadlineExceededCount++;
      if (result.reason === "ownership_lost") this.counts.ownershipLostCount++;
      if (result.reason === "stopped") this.counts.stoppedCount++;
      this.counts.publishFailureCount += result.publishFailures;
      this.counts.replayCount += result.replayAttempts;
      this.counts.resumeCount += result.resumeRequests;
      this.scheduleFlush();
      if (!sampled && !diagnostic) return;
      this.capture(
        "desktop_ack_command_settled",
        {
          ...properties,
          telemetry_sample_rate: diagnostic ? 1 : 0.1,
          outcome: result.outcome,
          reason: result.reason,
          ...(result.reason === "stopped" &&
            result.outcome === "incomplete" &&
            isDesktopAckStopSource(stopSource) && { stopSource }),
          observedFrames: result.observedFrames,
          enqueuedFrames: result.enqueuedFrames,
          acknowledgedFrames: result.acknowledgedFrames,
          publishAttempts: result.publishAttempts,
          replayAttempts: result.replayAttempts,
          publishFailures: result.publishFailures,
          resumeRequests: result.resumeRequests,
          pendingFrames: result.pendingFrames,
          pendingBytes: result.pendingBytes,
          peakPendingBytes: result.peakPendingBytes,
          terminalType: result.terminalType,
          terminalExitCode: result.terminalExitCode ?? null,
          terminalAcknowledged: result.terminalAcknowledged,
          durationMs: result.durationMs,
          ...(isDesktopAckAge(result.oldestPendingAgeMs) && {
            oldestPendingAgeMs: result.oldestPendingAgeMs,
          }),
          ...(isDesktopAckAge(result.lastAcknowledgementAgeMs) && {
            lastAcknowledgementAgeMs: result.lastAcknowledgementAgeMs,
          }),
          ...(isDesktopAckAge(result.publishInFlightAgeMs) && {
            publishInFlightAgeMs: result.publishInFlightAgeMs,
          }),
        },
        dedupeKey,
      );
    };
  }
}
