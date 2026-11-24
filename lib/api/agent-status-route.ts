import { NextRequest, NextResponse } from "next/server";
import { ApiError, runs } from "@trigger.dev/sdk";

import {
  getUserIDAndPro,
  type AuthKitSessionPhase,
  type AuthSessionPhase,
} from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";
import { handleAgentRouteError } from "@/lib/api/agent-route-errors";
import type { AgentApiEndpoint } from "@/lib/api/agent-endpoints";
import { closeAgentApprovalSession } from "@/lib/api/agent-approval-session";
import { getChatById, setActiveTriggerRun } from "@/lib/db/actions";
import { withAgentConvexScope } from "@/lib/api/agent-convex";

import { recoverCrashedAgentRun } from "./agent-crash-recovery";
import { AgentCrashRecoveryReplayLimitError } from "./agent-crash-recovery-error";
import { createTriggerRunReadDiagnostics } from "./trigger-run-read-diagnostics";

type AgentStatusRequestBody = {
  chatId?: unknown;
  runId?: unknown;
};

type TriggerRunStatus = {
  metadata?: unknown;
  status?: string;
  tags?: string[];
};

// One attempt per poll, aborted at the deadline (the pinned core patch passes
// this read's signal to its fetch): the browser's next poll is the retry.
const TRIGGER_RUN_READ_DEADLINE_MS = 5_000;
const MISSING_RUN_STATUSES = new Set([400, 404, 410, 422]);
const AUTHKIT_SESSION_PHASES = new Set<AuthKitSessionPhase>([
  "read_cookie",
  "prepare_anonymous_response",
  "verify_access_token",
  "refresh_request",
  "finish_refresh",
  "prepare_refresh_fallback",
]);
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
}) =>
  // A fresh bounded client: the ownership read's budget is already spent, and
  // a stalled cleanup must still end as a retryable failure before Vercel's.
  withAgentConvexScope("statusTerminalCleanup", async (convex) => {
    const chat = await getChatById({ id: chatId }, convex);
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
    return await setActiveTriggerRun(
      {
        chatId,
        triggerRunId: null,
        approvalSessionId: null,
        expectedRunId: runId,
        ...(recoveredCrash ? { recoveredCrash } : {}),
        clearApprovalPending: true,
      },
      convex,
    );
  });

export const createAgentStatusPost =
  ({ endpoint }: { endpoint: AgentApiEndpoint }) =>
  async (req: NextRequest) => {
    let stage = "read_request";
    let authPhase: AuthSessionPhase | undefined;
    let authKitSessionPhase: AuthKitSessionPhase | undefined;
    let userId: string | undefined;
    let chatId: string | undefined;
    let runId: string | undefined;
    let ownedRun: { chatId: string; runId: string } | undefined;
    let triggerRunRead:
      ReturnType<typeof createTriggerRunReadDiagnostics> | undefined;
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
            ...(stage === "retrieve_trigger_run" && triggerRunRead?.snapshot()),
            ...(stage === "authenticate" && {
              auth_phase_diagnostic_version: 1,
              auth_phase: authPhase ?? "not_observed",
              ...(authPhase === "session" &&
                authKitSessionPhase && {
                  authkit_session_phase: authKitSessionPhase,
                }),
            }),
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
      const authContext = await getUserIDAndPro(
        req,
        (phase) => {
          if (
            phase === "load_sdk" ||
            phase === "session" ||
            phase === "entitlements"
          )
            authPhase = phase;
        },
        (phase) => {
          if (AUTHKIT_SESSION_PHASES.has(phase)) authKitSessionPhase = phase;
        },
      );
      userId = authContext.userId;

      stage = "get_chat";
      // Bound the ownership read, including a connection that never returns
      // headers. Its typed 503 is nonterminal: the browser keeps this run and
      // polls again, and nothing about the run is read or changed first.
      const ownedChatId = chatId;
      const chat = await withAgentConvexScope("statusOwnershipRead", (convex) =>
        getChatById({ id: ownedChatId }, convex),
      );
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
      const read = createTriggerRunReadDiagnostics({ runId });
      triggerRunRead = read;
      const readRunId = runId;
      let run: TriggerRunStatus;
      let readDeadline: ReturnType<typeof setTimeout> | undefined;
      const readAbort = new AbortController();
      const readOptions = {
        ...read.requestOptions,
        retry: { maxAttempts: 1 },
        signal: readAbort.signal,
        // Status, tags and metadata are all this route reads. Skip the SDK's
        // presigned payload/output downloads, which this signal cannot stop.
        prepareData: <T>(data: T) => data,
      };
      try {
        // A late result or rejection is consumed by the race and ignored. The
        // typed 503 is nonterminal: the run, its association and approval
        // session stay untouched, and the browser polls this run again.
        run = (await Promise.race([
          read.run(() => runs.retrieve(readRunId, readOptions)),
          new Promise<never>((_, reject) => {
            readDeadline = setTimeout(() => {
              // Settle with the typed 503 before aborting, so the aborted
              // fetch's own rejection cannot replace the retry semantics.
              reject(
                new ChatSDKError(
                  "offline:api",
                  "Agent run status is temporarily unavailable. Retry the status check shortly.",
                ),
              );
              try {
                console.warn(
                  JSON.stringify({
                    timestamp: new Date().toISOString(),
                    level: "warn",
                    event: "agent_status_trigger_read_deadline",
                    service: "hackerai-web",
                    environment:
                      process.env.VERCEL_ENV ??
                      process.env.NODE_ENV ??
                      "unknown",
                    endpoint,
                    user_id: userId,
                    chat_id: ownedRun?.chatId,
                    trigger_run_id: ownedRun?.runId,
                    stage,
                    ...read.snapshot(),
                    elapsed_ms: Date.now() - requestStartedAt,
                    trigger_run_read_deadline_ms: TRIGGER_RUN_READ_DEADLINE_MS,
                  }),
                );
              } catch {
                // Optional diagnostics must not replace the deadline response.
              }
              // After the snapshot: stop this expired request, including a
              // response body still being held.
              readAbort.abort();
            }, TRIGGER_RUN_READ_DEADLINE_MS);
          }),
        ])) as TriggerRunStatus;
      } finally {
        clearTimeout(readDeadline);
        // Keep the last state for warnings; ignore events after settlement.
        read.finish();
      }
      if (!runBelongsToChatOwner(run, { chatId, userId })) {
        const metadataRecord =
          run.metadata != null &&
          typeof run.metadata === "object" &&
          !Array.isArray(run.metadata)
            ? (run.metadata as Record<string, unknown>)
            : undefined;
        const missingOwnerMetadata =
          run.metadata == null ||
          (metadataRecord !== undefined &&
            (metadataRecord.chatId === undefined ||
              metadataRecord.chatId === chatId) &&
            (metadataRecord.userId === undefined ||
              metadataRecord.userId === userId));
        // Session metadata is not copied onto its first run. The worker fills
        // ownership metadata shortly after starting. Keep an owned, associated
        // approval run polling without disclosing its actual status or changing
        // state until that independent ownership check becomes available.
        if (
          chat.active_agent_approval_session_id &&
          missingOwnerMetadata &&
          run.tags?.includes(`user_${userId}`) &&
          run.tags.includes(`chat_${chatId}`)
        ) {
          if (run.status && TERMINAL_RUN_STATUSES.has(run.status)) {
            // Startup can fail before the worker writes ownership metadata.
            // The associated run and server tags permit cleanup, but missing
            // metadata cannot safely drive a crash-recovery replay.
            stage = "clear_uninitialized_terminal_trigger_run";
            const outcome = await clearTerminalAgentRun({
              chatId,
              userId,
              runId,
            });
            return NextResponse.json({
              status: outcome === "stale" ? "DETACHED" : run.status,
              terminal: true,
            });
          }
          if (
            ["PENDING_VERSION", "QUEUED", "DEQUEUED", "EXECUTING"].includes(
              run.status ?? "",
            )
          ) {
            return NextResponse.json(
              { status: "INITIALIZING", terminal: false },
              { status: 202 },
            );
          }
        }
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
                ...error.context,
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
