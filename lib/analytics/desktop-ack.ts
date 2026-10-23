import {
  captureQueuedAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
} from "./client";
import type { AcknowledgedCommandSettlement } from "../centrifugo/acknowledged-command-output";

interface DesktopAckContext {
  connectionId: string | null;
  commandId: string;
  chatId?: string;
  triggerRunId?: string;
}

/** A start/final pair for identified clients; absent finals remain unknown. */
export function startDesktopAckTelemetry(context: DesktopAckContext) {
  const userId = getIdentifiedAnalyticsUserId();
  const commit = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
  const properties = {
    schemaVersion: 1,
    outputProtocol: "ack-v1",
    connectionId: context.connectionId,
    commandId: context.commandId,
    ...(context.chatId && { chatId: context.chatId }),
    ...(context.triggerRunId && { triggerRunId: context.triggerRunId }),
    ...(/^[a-f0-9]{40}$/i.test(commit ?? "") && {
      hackerai_frontend_build_commit: commit,
    }),
  };
  const dedupeKey = `${context.connectionId}:${context.commandId}`;
  const capture = (event: string, fields: Record<string, unknown>) => {
    // Never attribute an old command to a replacement signed-in account.
    if (!userId || getIdentifiedAnalyticsUserId() !== userId) return;
    try {
      captureQueuedAuthenticatedEvent({ event, properties: fields, dedupeKey });
    } catch {
      // Analytics is best effort and must not alter command delivery.
    }
  };
  capture("desktop_ack_command_started", properties);
  let settled = false;
  return (result: Readonly<AcknowledgedCommandSettlement>) => {
    if (settled) return;
    settled = true;
    capture("desktop_ack_command_settled", {
      ...properties,
      outcome: result.outcome,
      reason: result.reason,
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
      terminalAcknowledged: result.terminalAcknowledged,
      durationMs: result.durationMs,
    });
  };
}
