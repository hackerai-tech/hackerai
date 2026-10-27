import { NextRequest, NextResponse } from "next/server";
import { ApiError, runs } from "@trigger.dev/sdk";

import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { handleAgentRouteError } from "@/lib/api/agent-route-errors";
import type { AgentApiEndpoint } from "@/lib/api/agent-endpoints";
import { closeAgentApprovalSession } from "@/lib/api/agent-approval-session";
import { getChatById, setActiveTriggerRun } from "@/lib/db/actions";

import { recoverCrashedAgentRun } from "./agent-crash-recovery";
import { AgentCrashRecoveryReplayLimitError } from "./agent-crash-recovery-error";

type AgentStatusRequestBody = {
  chatId?: unknown;
  runId?: unknown;
};

type TriggerRunStatus = {
  metadata?: unknown;
  status?: string;
};

const MISSING_RUN_STATUSES = new Set([400, 404, 410, 422]);
const TERMINAL_RUN_STATUSES = new Set([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
]);

const isMissingTriggerRunError = (error: unknown): boolean =>
  error instanceof ApiError &&
  error.status !== undefined &&
  MISSING_RUN_STATUSES.has(error.status);

const runBelongsToChatOwner = (
  run: TriggerRunStatus,
  expected: { chatId: string; userId: string },
): boolean => {
  if (!run.metadata || typeof run.metadata !== "object") return false;
  const metadata = run.metadata as Record<string, unknown>;
  return (
    metadata.chatId === expected.chatId && metadata.userId === expected.userId
  );
};

const clearTerminalAgentRun = async ({
  chatId,
  userId,
  runId,
  recoveredCrash,
}: {
  chatId: string;
  userId: string;
  runId: string;
  recoveredCrash?: boolean;
}) => {
  const chat = await getChatById({ id: chatId });
  if (
    !chat ||
    chat.user_id !== userId ||
    chat.active_trigger_run_id !== runId
  ) {
    return "stale" as const;
  }

  await closeAgentApprovalSession(
    chat.active_agent_approval_session_id,
    "agent-run-terminal",
  );
  return await setActiveTriggerRun({
    chatId,
    triggerRunId: null,
    approvalSessionId: null,
    expectedRunId: runId,
    ...(recoveredCrash ? { recoveredCrash } : {}),
    clearApprovalPending: true,
  });
};

export const createAgentStatusPost =
  ({ endpoint }: { endpoint: AgentApiEndpoint }) =>
  async (req: NextRequest) => {
    let stage = "read_request";
    let userId: string | undefined;
    let chatId: string | undefined;
    let runId: string | undefined;
    let ownedRun: { chatId: string; runId: string } | undefined;
    const requestId =
      req.headers.get("x-request-id") ??
      req.headers.get("x-vercel-id") ??
      undefined;
    const requestStartedAt = Date.now();
    // Vercel's 30s hard timeout can bypass catch/finally. Capture the pending
    // stage beforehand, with a fixed two-warning budget for the whole request.
    const slowRequestTimers = [10_000, 20_000].map((delay) =>
      setTimeout(() => {
        const elapsedMs = Date.now() - requestStartedAt;
        console.warn(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "warn",
            event: "agent_status_slow_request",
            service: "hackerai-web",
            environment:
              process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
            endpoint,
            user_id: userId,
            chat_id: ownedRun?.chatId,
            trigger_run_id: ownedRun?.runId,
            stage,
            elapsed_ms: elapsedMs,
            warning_threshold_ms: delay,
            timer_lateness_ms: Math.max(0, elapsedMs - delay),
          }),
        );
      }, delay),
    );

    try {
      let body: AgentStatusRequestBody;
      try {
        body = (await req.json()) as AgentStatusRequestBody;
      } catch {
        return new NextResponse("Invalid JSON body", { status: 400 });
      }

      chatId = typeof body.chatId === "string" ? body.chatId : undefined;
      runId = typeof body.runId === "string" ? body.runId : undefined;

      if (!chatId) {
        return new NextResponse("chatId required", { status: 400 });
      }
      if (!runId) {
        return new NextResponse("runId required", { status: 400 });
      }

      stage = "authenticate";
      const authContext = await getUserIDAndPro(req);
      userId = authContext.userId;

      stage = "get_chat";
      const chat = await getChatById({ id: chatId });
      if (!chat) {
        return new NextResponse("Chat not found", { status: 404 });
      }
      if (chat.user_id !== userId) {
        return new NextResponse("Forbidden", { status: 403 });
      }

      // The Agent task clears this association as soon as its user-visible
      // answer is persisted, before post-run cleanup finishes in Trigger.dev.
      // Treat that detached state as UI-terminal so the browser does not keep
      // showing Stop while only backend cleanup remains.
      if (chat.active_trigger_run_id !== runId) {
        return NextResponse.json({ status: "DETACHED", terminal: true });
      }

      ownedRun = { chatId: chat.id, runId: chat.active_trigger_run_id };
      stage = "retrieve_trigger_run";
      const run = (await runs.retrieve(runId)) as TriggerRunStatus;
      if (!runBelongsToChatOwner(run, { chatId, userId })) {
        return new NextResponse("Forbidden", { status: 403 });
      }

      const terminal = Boolean(
        run.status && TERMINAL_RUN_STATUSES.has(run.status),
      );
      if (terminal) {
        if (run.status === "CRASHED") {
          stage = "recover_crashed_trigger_run";
          let outcome: "recovered" | "stale";
          try {
            outcome = await recoverCrashedAgentRun({
              chatId,
              userId,
              runId,
              metadata: run.metadata,
            });
          } catch (error) {
            if (!(error instanceof AgentCrashRecoveryReplayLimitError))
              throw error;
            console.warn(
              JSON.stringify({
                event: "agent_crash_recovery_blocked",
                service: "hackerai-web",
                action: "status",
                reason: "replay_byte_limit",
                chat_id: chatId.slice(0, 128),
                user_id: userId.slice(0, 128),
                trigger_run_id: runId.slice(0, 128),
              }),
            );
            // Report the real terminal state so clients stop polling. Preserve
            // the association and approval session; no replay was persisted.
            return NextResponse.json({
              status: "CRASHED",
              terminal: true,
              recovery: "blocked",
            });
          }
          if (outcome === "stale")
            return NextResponse.json({ status: "DETACHED", terminal: true });
        }
        stage = "clear_terminal_trigger_run";
        const detachOutcome = await clearTerminalAgentRun({
          chatId,
          userId,
          runId,
          recoveredCrash: run.status === "CRASHED",
        });
        if (run.status === "CRASHED" && detachOutcome === "stale")
          return NextResponse.json({ status: "DETACHED", terminal: true });
      }

      return NextResponse.json({ status: run.status, terminal });
    } catch (error) {
      if (stage === "retrieve_trigger_run" && isMissingTriggerRunError(error)) {
        if (chatId && userId && runId) {
          stage = "clear_missing_trigger_run";
          await clearTerminalAgentRun({ chatId, userId, runId }).catch(
            () => undefined,
          );
        }
        return new NextResponse("Run not found", { status: 404 });
      }

      return handleAgentRouteError({
        error,
        endpoint,
        action: "status",
        fallbackMessage: "Failed to retrieve run status",
        context: {
          requestId,
          userId,
          chatId,
          runId,
          stage,
        },
      });
    } finally {
      slowRequestTimers.forEach(clearTimeout);
    }
  };
