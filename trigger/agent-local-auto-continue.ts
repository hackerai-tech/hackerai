import PostHogClient from "@/app/posthog";
import { api } from "@/convex/_generated/api";
import { getConvexClient, setConvexUrl } from "@/lib/db/convex-client";
import { getLocalStopDiagnostic } from "@/lib/chat/local-connection-stop";
import { isDesktopPreference } from "@/lib/sandbox/environment";
import { createLocalAutoContinueTelemetry } from "@/lib/experiments/agent-local-auto-continue.server";
import type { AgentLongPayload } from "./agent-long";

/**
 * Records a Desktop run's lost-connection stop after the run released its
 * chat, so the server can continue it once when the same Desktop session
 * comes back (HAC-275). Both experiment arms record it; the arm is only read
 * at the return. Never throws: a failure leaves the manual Resume prompt.
 */
export async function recordLocalAutoContinueStop({
  payload,
  stoppedRunId,
  runStartedAt,
  stopCause,
  usageLimited,
}: {
  payload: AgentLongPayload;
  stoppedRunId: string;
  /** When the stopped run was created: a later Stop or switch applies to it. */
  runStartedAt?: number;
  stopCause: unknown;
  usageLimited: boolean;
}) {
  // A goal owns its chat's continuation; CLI hosts never prove a session.
  if (
    payload.goalGeneration !== undefined ||
    !isDesktopPreference(payload.sandboxPreference ?? "e2b")
  )
    return;
  const diagnostic = getLocalStopDiagnostic(stopCause);
  try {
    if (payload.convexUrl) setConvexUrl(payload.convexUrl);
    const { created, decision } = await getConvexClient().mutation(
      api.agentLocalAutoContinues.recordStop,
      {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        stoppedRunId,
        chatId: payload.chatId,
        userId: payload.userId,
        ...(diagnostic && { stopReason: diagnostic.reason }),
        ...(runStartedAt !== undefined && { runStartedAt }),
        ...(diagnostic?.connectionId && {
          connectionId: diagnostic.connectionId,
        }),
        usageLimited,
        ...(payload.sandboxPreference && {
          sandboxPreference: payload.sandboxPreference,
        }),
        ...(payload.agentPermissionMode && {
          agentPermissionMode: payload.agentPermissionMode,
        }),
        ...(payload.selectedModel && { selectedModel: payload.selectedModel }),
      },
    );
    if (
      !created ||
      (decision.state !== "ineligible" && decision.state !== "cancelled")
    )
      return;
    const posthog = PostHogClient();
    createLocalAutoContinueTelemetry(posthog).outcome(decision.state, {
      userId: payload.userId,
      chatId: decision.chatId,
      stoppedRunId,
      stopReason: decision.stopReason,
      reason: decision.reason,
    });
    await posthog?.shutdown(1000).catch(() => undefined);
  } catch (error) {
    console.warn("Could not record a Desktop stop for automatic continuation", {
      chatId: payload.chatId,
      stoppedRunId,
      error: error instanceof Error ? error.name : typeof error,
    });
  }
}
