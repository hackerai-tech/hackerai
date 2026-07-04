import { NextRequest, NextResponse } from "next/server";
import { runs, sessions } from "@trigger.dev/sdk";

import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import {
  getChatById,
  getActiveTriggerRun,
  setActiveTriggerRun,
} from "@/lib/db/actions";
import { handleAgentRouteError } from "@/lib/api/agent-route-errors";
import type { AgentApiEndpoint } from "@/lib/api/agent-endpoints";

const closeApprovalSession = async (
  approvalSessionId: string | undefined,
): Promise<void> => {
  if (!approvalSessionId) return;
  try {
    await sessions.close(approvalSessionId, { reason: "agent-run-canceled" });
  } catch {
    // Ignore: the session may already be closed or unavailable.
  }
};

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
      if (!chat || chat.user_id !== userId) {
        return new NextResponse("Forbidden", { status: 403 });
      }

      const approvalSessionId = chat.active_agent_approval_session_id;
      const runId = await getActiveTriggerRun({ chatId });
      await closeApprovalSession(approvalSessionId);
      if (!runId) {
        if (approvalSessionId) {
          await setActiveTriggerRun({
            chatId,
            triggerRunId: null,
            approvalSessionId: null,
          });
        }
        // No active run — treat as already-stopped (idempotent).
        return NextResponse.json({ canceled: false, reason: "no_active_run" });
      }

      // Best-effort cancel — the run may have already failed/completed.
      // Either way we want to clear the stored id so the UI unblocks.
      try {
        await runs.cancel(runId);
      } catch {
        // Ignore: run is already in a terminal state.
      }
      await setActiveTriggerRun({
        chatId,
        triggerRunId: null,
        approvalSessionId: null,
        expectedRunId: runId,
      });

      return NextResponse.json({ canceled: true, runId });
    } catch (error) {
      return handleAgentRouteError({
        error,
        endpoint,
        action: "cancel",
        fallbackMessage: "Failed to cancel run",
      });
    }
  };
