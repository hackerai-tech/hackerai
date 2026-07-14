import { NextRequest, NextResponse } from "next/server";

import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { getChatById, setActiveTriggerRun } from "@/lib/db/actions";
import { handleAgentRouteError } from "@/lib/api/agent-route-errors";
import type { AgentApiEndpoint } from "@/lib/api/agent-endpoints";
import {
  cancelAgentTriggerRun,
  clearTemporaryAgentApprovalRefreshCookie,
  closeAgentApprovalSession,
  getTemporaryAgentApprovalRefreshHandle,
} from "@/lib/api/agent-approval-session";
import { logger } from "@/lib/logger";

type AgentCancelRejectionReason =
  "chat_owner_mismatch" | "temporary_refresh_missing";

function logAgentCancelRejection({
  req,
  endpoint,
  userId,
  chatId,
  reason,
}: {
  req: NextRequest;
  endpoint: AgentApiEndpoint;
  userId: string;
  chatId: string;
  reason: AgentCancelRejectionReason;
}) {
  logger.warn("Rejected Agent cancellation request", {
    event: "agent_cancel_rejected",
    request_id: req.headers.get("x-vercel-id") ?? "unknown",
    service: "hackerai-web",
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
    route: `${endpoint}/cancel`,
    endpoint,
    action: "cancel",
    reason,
    status_code: 403,
    user_id: userId,
    chat_id: chatId,
  });
}

export const createAgentCancelPost =
  ({ endpoint }: { endpoint: AgentApiEndpoint }) =>
  async (req: NextRequest) => {
    try {
      let body: { chatId?: string };
      try {
        body = await req.json();
      } catch {
        return new NextResponse("Invalid JSON body", { status: 400 });
      }
      const { chatId } = body;
      if (!chatId || typeof chatId !== "string") {
        return new NextResponse("chatId required", { status: 400 });
      }

      const { userId } = await getUserIDAndPro(req);

      const chat = await getChatById({ id: chatId });
      if (chat && chat.user_id !== userId) {
        logAgentCancelRejection({
          req,
          endpoint,
          userId,
          chatId,
          reason: "chat_owner_mismatch",
        });
        return new NextResponse("Forbidden", { status: 403 });
      }

      const temporaryRefresh = chat
        ? null
        : getTemporaryAgentApprovalRefreshHandle({ req, userId, chatId });
      if (!chat && !temporaryRefresh) {
        logAgentCancelRejection({
          req,
          endpoint,
          userId,
          chatId,
          reason: "temporary_refresh_missing",
        });
        return new NextResponse("Forbidden", { status: 403 });
      }

      const approvalSessionId = chat
        ? chat.active_agent_approval_session_id
        : temporaryRefresh?.approvalSessionId;
      const runId = chat ? chat.active_trigger_run_id : temporaryRefresh?.runId;
      await closeAgentApprovalSession(approvalSessionId, "agent-run-canceled");
      if (!runId) {
        if (approvalSessionId) {
          await setActiveTriggerRun({
            chatId,
            triggerRunId: null,
            approvalSessionId: null,
            expectedApprovalSessionId: approvalSessionId,
            clearApprovalPending: true,
          });
        }
        // No active run — treat as already-stopped (idempotent).
        return NextResponse.json({ canceled: false, reason: "no_active_run" });
      }

      await cancelAgentTriggerRun(runId);
      if (chat) {
        await setActiveTriggerRun({
          chatId,
          triggerRunId: null,
          approvalSessionId: null,
          expectedRunId: runId,
          ...(approvalSessionId
            ? { expectedApprovalSessionId: approvalSessionId }
            : {}),
          clearApprovalPending: true,
        });
      }

      const response = NextResponse.json({ canceled: true, runId });
      if (temporaryRefresh) {
        clearTemporaryAgentApprovalRefreshCookie(response, {
          req,
          userId,
          chatId,
        });
      }
      return response;
    } catch (error) {
      return handleAgentRouteError({
        error,
        endpoint,
        action: "cancel",
        fallbackMessage: "Failed to cancel run",
      });
    }
  };
