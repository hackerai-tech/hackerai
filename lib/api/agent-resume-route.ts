import { NextRequest, NextResponse } from "next/server";
import { runs, auth, ApiError } from "@trigger.dev/sdk";

import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { getChatById, setActiveTriggerRun } from "@/lib/db/actions";
import { handleAgentRouteError } from "@/lib/api/agent-route-errors";
import type { AgentApiEndpoint } from "@/lib/api/agent-endpoints";
import {
  AGENT_APPROVAL_PROTOCOL_VERSION,
  AGENT_APPROVAL_TOKEN_EXPIRATION,
  clearTemporaryAgentApprovalRefreshCookie,
  closeAgentApprovalSession,
  getTemporaryAgentApprovalRefreshHandle,
  setTemporaryAgentApprovalRefreshCookie,
} from "@/lib/api/agent-approval-session";

const TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
]);

export const createAgentResumeGet =
  ({ endpoint }: { endpoint: AgentApiEndpoint }) =>
  async (req: NextRequest) => {
    let stage = "authenticate";
    let userId: string | undefined;
    let chatId: string | undefined;
    let runId: string | undefined;
    let approvalSessionId: string | undefined;
    let isTemporaryRefresh = false;
    const requestId =
      req.headers.get("x-request-id") ??
      req.headers.get("x-vercel-id") ??
      undefined;
    const requestStartedAt = Date.now();
    const slowRequestInterval = setInterval(() => {
      console.warn(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "warn",
          event: "agent_resume_slow_request",
          service: "hackerai-web",
          environment:
            process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
          endpoint,
          request_id: requestId,
          user_id: userId,
          chat_id: chatId,
          trigger_run_id: runId,
          stage,
          elapsed_ms: Date.now() - requestStartedAt,
        }),
      );
    }, 10_000);

    try {
      const authContext = await getUserIDAndPro(req);
      userId = authContext.userId;

      stage = "validate_request";
      chatId = req.nextUrl.searchParams.get("chatId") ?? undefined;
      if (!chatId) {
        return new NextResponse("chatId required", { status: 400 });
      }

      stage = "get_chat";
      const chat = await getChatById({ id: chatId });
      if (chat && chat.user_id !== userId) {
        return new NextResponse("Forbidden", { status: 403 });
      }
      if (chat) {
        runId = chat.active_trigger_run_id;
        approvalSessionId = chat.active_agent_approval_session_id;
      } else {
        const temporaryRefresh = getTemporaryAgentApprovalRefreshHandle({
          req,
          userId,
          chatId,
        });
        if (!temporaryRefresh) {
          return new NextResponse("Forbidden", { status: 403 });
        }
        runId = temporaryRefresh.runId;
        approvalSessionId = temporaryRefresh.approvalSessionId;
        isTemporaryRefresh = true;
      }
      if (!runId) {
        const response = new NextResponse(null, { status: 204 });
        if (isTemporaryRefresh) {
          clearTemporaryAgentApprovalRefreshCookie(response, {
            req,
            userId,
            chatId,
          });
        }
        return response;
      }

      let runStatus: string | undefined;
      try {
        stage = "retrieve_trigger_run";
        const run = await runs.retrieve(runId);
        runStatus = run.status;
      } catch (err) {
        // Only treat a 404 as "run gone" so we self-heal the stored id.
        // Re-throw transient errors (network, 5xx) to leave the mapping intact.
        if (err instanceof ApiError && err.status === 404) {
          runStatus = "EXPIRED";
        } else {
          throw err;
        }
      }

      if (runStatus && TERMINAL_STATUSES.has(runStatus)) {
        stage = "clear_terminal_trigger_run";
        await closeAgentApprovalSession(
          approvalSessionId,
          "agent-run-terminal",
        );
        if (chat) {
          await setActiveTriggerRun({
            chatId,
            triggerRunId: null,
            approvalSessionId: null,
            expectedRunId: runId,
            clearApprovalPending: true,
          });
        }
        const response = new NextResponse(null, { status: 204 });
        if (isTemporaryRefresh) {
          clearTemporaryAgentApprovalRefreshCookie(response, {
            req,
            userId,
            chatId,
          });
        }
        return response;
      }

      stage = "create_public_token";
      const [publicAccessToken, approvalSessionPublicAccessToken] =
        await Promise.all([
          auth.createPublicToken({
            scopes: { read: { runs: [runId] } },
            expirationTime: "6h",
          }),
          approvalSessionId
            ? auth.createPublicToken({
                scopes: {
                  write: { sessions: approvalSessionId },
                } as any,
                expirationTime: AGENT_APPROVAL_TOKEN_EXPIRATION,
              })
            : Promise.resolve(undefined),
        ]);

      const response = NextResponse.json({
        runId,
        publicAccessToken,
        chatId,
        approvalProtocolVersion: AGENT_APPROVAL_PROTOCOL_VERSION,
        ...(approvalSessionId && approvalSessionPublicAccessToken
          ? {
              approvalSessionId,
              approvalSessionPublicAccessToken,
            }
          : {}),
      });
      if (isTemporaryRefresh && approvalSessionId) {
        setTemporaryAgentApprovalRefreshCookie(response, {
          req,
          userId,
          chatId,
          runId,
          approvalSessionId,
        });
      }
      return response;
    } catch (error) {
      return handleAgentRouteError({
        error,
        endpoint,
        action: "resume",
        fallbackMessage: "Failed to resume run",
        context: {
          requestId,
          userId,
          chatId,
          runId,
          stage,
        },
      });
    } finally {
      clearInterval(slowRequestInterval);
    }
  };
