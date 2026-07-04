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
    try {
      const { userId } = await getUserIDAndPro(req);

      const chatId = req.nextUrl.searchParams.get("chatId");
      if (!chatId) {
        return new NextResponse("chatId required", { status: 400 });
      }

      const chat = await getChatById({ id: chatId });
      if (!chat || chat.user_id !== userId) {
        return new NextResponse("Forbidden", { status: 403 });
      }

      const runId = await getActiveTriggerRun({ chatId });
      if (!runId) {
        return new NextResponse(null, { status: 204 });
      }

      let runStatus: string | undefined;
      try {
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
        await setActiveTriggerRun({
          chatId,
          triggerRunId: null,
          expectedRunId: runId,
        });
        return new NextResponse(null, { status: 204 });
      }

      const publicAccessToken = await auth.createPublicToken({
        scopes: { read: { runs: [runId] } },
        expirationTime: "6h",
      });

      return NextResponse.json({ runId, publicAccessToken, chatId });
    } catch (error) {
      return handleAgentRouteError({
        error,
        endpoint,
        action: "resume",
        fallbackMessage: "Failed to resume run",
      });
    }
  };
