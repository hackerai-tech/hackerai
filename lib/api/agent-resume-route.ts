import { NextRequest, NextResponse } from "next/server";
import { runs, auth, ApiError } from "@trigger.dev/sdk";

import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import {
  getChatById,
  getActiveTriggerRun,
  setActiveTriggerRun,
} from "@/lib/db/actions";
import { handleAgentRouteError } from "@/lib/api/agent-route-errors";
import type { AgentApiEndpoint } from "@/lib/api/agent-endpoints";

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
    const requestId =
      req.headers.get("x-request-id") ??
      req.headers.get("x-vercel-id") ??
      undefined;

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
      if (!chat || chat.user_id !== userId) {
        return new NextResponse("Forbidden", { status: 403 });
      }

      stage = "get_active_trigger_run";
      runId = (await getActiveTriggerRun({ chatId })) ?? undefined;
      if (!runId) {
        return new NextResponse(null, { status: 204 });
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
        await setActiveTriggerRun({
          chatId,
          triggerRunId: null,
          approvalSessionId: null,
          expectedRunId: runId,
        });
        return new NextResponse(null, { status: 204 });
      }

      stage = "create_public_token";
      const [publicAccessToken, approvalSessionPublicAccessToken] =
        await Promise.all([
          auth.createPublicToken({
            scopes: { read: { runs: [runId] } },
            expirationTime: "6h",
          }),
          chat.active_agent_approval_session_id
            ? auth.createPublicToken({
                scopes: {
                  read: { sessions: chat.active_agent_approval_session_id },
                  write: { sessions: chat.active_agent_approval_session_id },
                } as any,
                expirationTime: "6h",
              })
            : Promise.resolve(undefined),
        ]);

      return NextResponse.json({
        runId,
        publicAccessToken,
        chatId,
        ...(chat.active_agent_approval_session_id &&
        approvalSessionPublicAccessToken
          ? {
              approvalSessionId: chat.active_agent_approval_session_id,
              approvalSessionPublicAccessToken,
            }
          : {}),
      });
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
    }
  };
